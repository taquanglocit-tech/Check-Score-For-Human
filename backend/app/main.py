import json
import os
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from .adapters import parse_cvat_coco_zip
from .db import STORAGE, get_session, init_db
from .evaluation import compute_benchmark_comparison
from .models import Asset, LabelSet, Project
from .schemas import LabelBundle, ProjectCreate


MAX_FILE_BYTES = 32 * 1024 * 1024

@asynccontextmanager
async def lifespan(app):
    init_db()
    yield

app = FastAPI(title="M49 Annotation Benchmark API", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(","), allow_methods=["*"], allow_headers=["*"])


def get_project(project_id: str, session: Session):
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Không tìm thấy dự án")
    return project

async def read_limited(file: UploadFile):
    data = await file.read(MAX_FILE_BYTES + 1)
    await file.close()
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(413, "Mỗi tệp tối đa 32 MiB")
    if not data:
        raise HTTPException(400, "Tệp rỗng")
    return data

@app.get("/api/health")
def health():
    return {"status": "ok"}

@app.post("/api/projects", status_code=201)
def create_project(body: ProjectCreate, session: Session = Depends(get_session)):
    project = Project(**body.model_dump())
    session.add(project)
    session.commit()
    session.refresh(project)
    return project

@app.get("/api/projects")
def projects(session: Session = Depends(get_session)):
    return session.exec(select(Project).order_by(Project.created_at.desc())).all()

@app.get("/api/projects/{project_id}/assets")
def assets(project_id: str, session: Session = Depends(get_session)):
    get_project(project_id, session)
    rows = session.exec(select(Asset).where(Asset.project_id == project_id)).all()
    return [{**a.model_dump(exclude={"storage_name"}), "url": f"/api/assets/{a.id}/file"} for a in rows]

@app.post("/api/projects/{project_id}/assets", status_code=201)
async def upload_asset(project_id: str, file: UploadFile = File(...), session: Session = Depends(get_session)):
    project = get_project(project_id, session)
    name = (file.filename or "").replace("\\", "/").split("/")[-1]
    ext = Path(name).suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".bin", ".pcd"}:
        raise HTTPException(400, "Hỗ trợ JPG, PNG; dự án 3D hỗ trợ thêm BIN/PCD")
    if ext in {".bin", ".pcd"} and project.task != "detection_3d":
        raise HTTPException(400, "Point cloud chỉ dùng cho dự án 3D")
    if session.exec(select(Asset).where(Asset.project_id == project_id, Asset.name == name)).first():
        raise HTTPException(409, "Tên tệp đã tồn tại trong dự án")
    data = await read_limited(file)
    width = height = None
    kind = "pointcloud"
    if ext in {".jpg", ".jpeg", ".png"}:
        try:
            with Image.open(BytesIO(data)) as img:
                if img.format not in {"JPEG", "PNG"}:
                    raise ValueError("Không phải ảnh JPEG/PNG")
                width, height = img.size
                img.verify()
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
            raise HTTPException(400, "Ảnh không hợp lệ")
        kind = "image"
    elif ext == ".bin" and len(data) % 16:
        raise HTTPException(400, "KITTI BIN cần các điểm float32 x,y,z,intensity (16 byte/điểm)")
    elif ext == ".pcd" and b"FIELDS" not in data[:4096]:
        raise HTTPException(400, "Không tìm thấy header PCD")
    storage_name = str(uuid4()) + ext
    path = STORAGE / storage_name
    path.write_bytes(data)
    asset = Asset(project_id=project_id, name=name, kind=kind, storage_name=storage_name, width=width, height=height, size_bytes=len(data))
    try:
        session.add(asset)
        session.commit()
        session.refresh(asset)
    except Exception as exc:
        session.rollback()
        path.unlink(missing_ok=True)
        if isinstance(exc, IntegrityError):
            raise HTTPException(409, "Tên tệp đã tồn tại")
        raise
    return asset.model_dump(exclude={"storage_name"})

@app.get("/api/assets/{asset_id}/file")
def asset_file(asset_id: str, session: Session = Depends(get_session)):
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(404, "Không tìm thấy tệp")
    path = STORAGE / asset.storage_name
    if not path.is_file():
        raise HTTPException(404, "Tệp lưu trữ bị thiếu")
    return FileResponse(path)


def save_bundle(project_id: str, source: str, bundle: LabelBundle, session: Session):
    project = get_project(project_id, session)
    if bundle.task != project.task:
        raise HTTPException(422, "Tác vụ của nhãn không khớp dự án")
    if source == "assisted":
        parent = session.get(LabelSet, bundle.parent_id) if bundle.parent_id else None
        if not parent or parent.project_id != project_id or parent.source != "ai":
            raise HTTPException(422, "Nhãn sửa AI cần parent_id của lần chạy AI trong cùng dự án")
    elif bundle.parent_id is not None:
        raise HTTPException(422, "parent_id chỉ dùng cho nhãn assisted")
    if source in {"manual", "assisted"} and not (bundle.annotator or "").strip():
        raise HTTPException(422, "Cần tên người gán nhãn")
    assets = {a.name: a for a in session.exec(select(Asset).where(Asset.project_id == project_id)).all()}
    seen = set()
    kind = {"detection_2d": "bbox2d", "instance_segmentation": "polygon", "detection_3d": "cuboid3d"}[project.task]
    for sample in bundle.samples:
        asset = assets.get(sample.asset_name)
        if not asset or sample.asset_name in seen:
            raise HTTPException(422, "Tên ảnh/point cloud không tồn tại hoặc trùng trong gói nhãn")
        seen.add(sample.asset_name)
        if (project.task == "detection_3d") != (asset.kind == "pointcloud"):
            raise HTTPException(422, "Nhãn 3D phải gắn với point cloud; nhãn 2D/mask phải gắn với ảnh")
        ids = set()
        for obj in sample.objects:
            if obj.id in ids or obj.category not in project.classes or obj.geometry.kind != kind:
                raise HTTPException(422, "ID trùng, lớp sai hoặc kiểu hình học không khớp")
            ids.add(obj.id)
            if source == "ai" and obj.confidence is None:
                raise HTTPException(422, "Dự đoán AI cần confidence")
            g = obj.geometry
            if kind == "bbox2d" and (g.xyxy[2] > asset.width or g.xyxy[3] > asset.height):
                raise HTTPException(422, "Khung nằm ngoài ảnh gốc")
            if kind == "polygon" and any(x < 0 or y < 0 or x > asset.width or y > asset.height for x, y in g.points):
                raise HTTPException(422, "Polygon nằm ngoài ảnh gốc")
    row = LabelSet(project_id=project_id, source=source, name=bundle.name, annotator=bundle.annotator, parent_id=bundle.parent_id, payload=bundle.model_dump(mode="json"))
    session.add(row)
    session.commit()
    session.refresh(row)
    return {"id": row.id, "source": source, "samples": len(bundle.samples)}

@app.post("/api/projects/{project_id}/imports/{source}", status_code=201)
async def import_labels(project_id: str, source: str, file: UploadFile = File(...), session: Session = Depends(get_session)):
    if source not in {"ground_truth", "ai"}:
        raise HTTPException(422, "Import chỉ hỗ trợ ground_truth hoặc ai")
    data = await read_limited(file)
    try:
        bundle = LabelBundle.model_validate_json(data)
    except ValidationError as exc:
        raise HTTPException(422, str(exc))
    return save_bundle(project_id, source, bundle, session)

@app.post("/api/projects/{project_id}/annotations/{source}", status_code=201)
def save_annotation(project_id: str, source: str, body: LabelBundle, session: Session = Depends(get_session)):
    if source not in {"manual", "assisted"}:
        raise HTTPException(422, "Chọn manual hoặc assisted")
    return save_bundle(project_id, source, body, session)

@app.get("/api/projects/{project_id}/label-sets")
def list_labels(project_id: str, session: Session = Depends(get_session)):
    get_project(project_id, session)
    rows = session.exec(select(LabelSet).where(LabelSet.project_id == project_id)).all()
    return [r.model_dump(exclude={"payload"}) for r in rows]

@app.get("/api/label-sets/{label_id}")
def label_detail(label_id: str, session: Session = Depends(get_session)):
    row = session.get(LabelSet, label_id)
    if not row:
        raise HTTPException(404, "Không tìm thấy bộ nhãn")
    return row.payload

@app.get("/api/projects/{project_id}/summary")
def summary(project_id: str, session: Session = Depends(get_session)):
    project = get_project(project_id, session)
    assets = session.exec(select(Asset).where(Asset.project_id == project_id)).all()
    labels = session.exec(select(LabelSet).where(LabelSet.project_id == project_id)).all()
    source_counts = {source: sum(r.source == source for r in labels) for source in ["ground_truth", "ai", "manual", "assisted"]}
    has_gt = source_counts["ground_truth"] > 0
    has_preds = any(source_counts[s] > 0 for s in ["manual", "ai", "assisted"])
    eval_status = "ready" if (has_gt and has_preds) else "waiting_for_data"
    return {"project": project, "assets": len(assets), "label_sets": source_counts, "evaluation_status": eval_status}

@app.post("/api/projects/{project_id}/imports-zip/{source}", status_code=201)
async def import_zip_labels(
    project_id: str,
    source: str,
    file: UploadFile = File(...),
    annotator: str | None = Form(None),
    parent_id: str | None = Form(None),
    total_seconds: float | None = Form(None),
    session: Session = Depends(get_session),
):
    if source not in {"ground_truth", "ai", "manual", "assisted"}:
        raise HTTPException(422, "Chỉ hỗ trợ ground_truth, ai, manual hoặc assisted")
    project = get_project(project_id, session)
    data = await read_limited(file)
    default_annotator = (
        annotator
        or ("AI Model" if source == "ai" else "Ground Truth" if source == "ground_truth" else "Human Annotator")
    )
    try:
        bundle = parse_cvat_coco_zip(
            zip_bytes=data,
            task=project.task,
            bundle_name=f"{source.upper()} · CVAT COCO ZIP",
            annotator=default_annotator,
            parent_id=parent_id,
            source=source,
            total_seconds=total_seconds,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    return save_bundle(project_id, source, bundle, session)

@app.get("/api/projects/{project_id}/benchmark")
def get_benchmark(project_id: str, iou_threshold: float = 0.5, session: Session = Depends(get_session)):
    get_project(project_id, session)
    labels = session.exec(
        select(LabelSet)
        .where(LabelSet.project_id == project_id)
        .order_by(LabelSet.created_at.desc())
    ).all()

    # Lấy phiên bản mới nhất của từng nguồn
    latest_by_source: dict[str, dict] = {}
    for l in labels:
        if l.source not in latest_by_source:
            latest_by_source[l.source] = l.payload

    if "ground_truth" not in latest_by_source:
        raise HTTPException(400, "Dự án chưa có Ground Truth để so sánh.")

    gt_payload = latest_by_source["ground_truth"]
    bundles = {k: v for k, v in latest_by_source.items() if k != "ground_truth"}

    if not bundles:
        raise HTTPException(400, "Cần ít nhất một nguồn nhãn (manual, ai hoặc assisted) để so sánh.")

    return compute_benchmark_comparison(gt_payload, bundles, iou_threshold=iou_threshold)

@app.get("/api/projects/{project_id}/visualize/{asset_name}")
def visualize_asset(project_id: str, asset_name: str, session: Session = Depends(get_session)):
    get_project(project_id, session)
    labels = session.exec(
        select(LabelSet)
        .where(LabelSet.project_id == project_id)
        .order_by(LabelSet.created_at.desc())
    ).all()

    # Thu thập objects của asset_name từ phiên bản mới nhất của từng nguồn
    layers: dict[str, list] = {"ground_truth": [], "ai": [], "manual": [], "assisted": []}
    seen_sources = set()

    for l in labels:
        if l.source not in seen_sources:
            seen_sources.add(l.source)
            for sample in l.payload.get("samples", []):
                if sample.get("asset_name") == asset_name:
                    layers[l.source] = sample.get("objects", [])
                    break

    return {"asset_name": asset_name, "layers": layers}

