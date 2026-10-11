import io
import json
import shutil
import zipfile
from pathlib import Path
from uuid import uuid4

from sqlmodel import Session, select

from .db import STORAGE
from .models import Asset, LabelSet, Project
from .schemas import Box2D, LabelBundle, ObjectLabel, RunMetadata, SampleLabels

STATIC_DIR = Path(__file__).parent / "static_dataset"
STATIC_IMAGES_DIR = STATIC_DIR / "images"
STATIC_GT_FILE = STATIC_DIR / "ground_truth.json"

DEFAULT_CLASSES = [
    "car",
    "pedestrian",
    "traffic sign",
    "traffic light",
    "truck",
    "bus",
    "rider",
    "motorcycle",
    "bicycle",
]


def create_benchmark_sample(
    project_name: str,
    sample_count: int,
    session: Session,
) -> dict:
    """
    Tạo hoặc khởi tạo một dự án Benchmark với N ảnh được trích xuất từ kho ảnh tĩnh,
    tự động nạp sẵn tài nguyên ảnh và bộ nhãn Ground Truth chuẩn.
    """
    if not STATIC_GT_FILE.exists():
        raise ValueError("Kho dữ liệu tĩnh Ground Truth chưa được thiết lập.")

    with open(STATIC_GT_FILE, "r", encoding="utf-8") as f:
        full_gt = json.load(f)

    all_samples = full_gt.get("samples", [])
    if not all_samples:
        raise ValueError("Kho dữ liệu tĩnh không có mẫu ảnh nào.")

    count = max(1, min(sample_count, len(all_samples)))
    selected_samples = all_samples[:count]
    selected_asset_names = {s["asset_name"] for s in selected_samples}

    # 1. Tạo Project mới
    clean_name = project_name.strip() or f"BDD100K Benchmark · {count} ảnh"
    project = Project(
        name=clean_name,
        task="detection_2d",
        classes=DEFAULT_CLASSES,
    )
    session.add(project)
    session.commit()
    session.refresh(project)

    # 2. Sao chép ảnh vào STORAGE và tạo Asset
    STORAGE.mkdir(parents=True, exist_ok=True)
    created_assets = []
    for s_name in selected_asset_names:
        src_img = STATIC_IMAGES_DIR / s_name
        if not src_img.exists():
            continue
        storage_name = f"{uuid4()}.jpg"
        shutil.copy2(src_img, STORAGE / storage_name)

        asset = Asset(
            project_id=project.id,
            name=s_name,
            kind="image",
            storage_name=storage_name,
            width=1280,
            height=720,
            size_bytes=src_img.stat().st_size,
        )
        session.add(asset)
        created_assets.append(asset)

    session.commit()

    # 3. Nạp Ground Truth của N ảnh này
    gt_bundle = {
        "schema_version": "1.0",
        "task": "detection_2d",
        "name": f"Ground Truth · {count} mẫu chuẩn",
        "annotator": "BDD100K Official",
        "parent_id": None,
        "run": {},
        "samples": selected_samples,
    }
    gt_row = LabelSet(
        project_id=project.id,
        source="ground_truth",
        name=f"Ground Truth · {count} mẫu chuẩn",
        annotator="BDD100K Official",
        payload=gt_bundle,
    )
    session.add(gt_row)
    session.commit()

    return {
        "project_id": project.id,
        "project_name": project.name,
        "sample_count": count,
        "assets_count": len(created_assets),
        "asset_names": [a.name for a in created_assets],
    }


def create_benchmark_from_zip(
    project_name: str,
    zip_bytes: bytes,
    session: Session,
) -> dict:
    """
    Cho phép người dùng tải tệp nén ZIP chứa ảnh lên Web,
    code sẽ tự động giải nén tất cả các ảnh và tạo một đợt thử nghiệm mới.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile:
        raise ValueError("Tệp tải lên không phải là tệp ZIP hợp lệ.")

    valid_extensions = {".jpg", ".jpeg", ".png", ".webp"}
    image_names = [
        name for name in archive.namelist()
        if Path(name).suffix.lower() in valid_extensions and not name.startswith("__MACOSX")
    ]

    if not image_names:
        raise ValueError("Tệp ZIP không chứa bất kỳ ảnh nào (.jpg, .png, .webp).")

    clean_name = project_name.strip() or f"Tùy Chỉnh · {len(image_names)} ảnh"
    project = Project(
        name=clean_name,
        task="detection_2d",
        classes=DEFAULT_CLASSES,
    )
    session.add(project)
    session.commit()
    session.refresh(project)

    STORAGE.mkdir(parents=True, exist_ok=True)
    created_assets = []
    seen_names = set()

    for img_path_in_zip in image_names:
        clean_name = Path(img_path_in_zip).name
        if clean_name in seen_names:
            continue
        seen_names.add(clean_name)

        img_bytes = archive.read(img_path_in_zip)
        storage_name = f"{uuid4()}{Path(clean_name).suffix.lower()}"
        (STORAGE / storage_name).write_bytes(img_bytes)

        asset = Asset(
            project_id=project.id,
            name=clean_name,
            kind="image",
            storage_name=storage_name,
            width=1280,
            height=720,
            size_bytes=len(img_bytes),
        )
        session.add(asset)
        created_assets.append(asset)

    session.commit()

    # Thử tìm nhãn Ground Truth tương ứng từ kho dữ liệu tĩnh
    gt_samples = []
    if STATIC_GT_FILE.exists():
        with open(STATIC_GT_FILE, "r", encoding="utf-8") as f:
            full_gt = json.load(f)
            gt_dict = {s["asset_name"]: s for s in full_gt.get("samples", [])}
            for a in created_assets:
                if a.name in gt_dict:
                    gt_samples.append(gt_dict[a.name])

    if not gt_samples:
        for a in created_assets:
            gt_samples.append({"asset_name": a.name, "objects": []})

    gt_bundle = {
        "schema_version": "1.0",
        "task": "detection_2d",
        "name": f"Ground Truth · {len(created_assets)} ảnh",
        "annotator": "User Uploaded",
        "parent_id": None,
        "run": {},
        "samples": gt_samples,
    }
    gt_row = LabelSet(
        project_id=project.id,
        source="ground_truth",
        name=f"Ground Truth · {len(created_assets)} ảnh",
        annotator="User Uploaded",
        payload=gt_bundle,
    )
    session.add(gt_row)
    session.commit()

    return {
        "project_id": project.id,
        "project_name": project.name,
        "sample_count": len(created_assets),
        "assets_count": len(created_assets),
        "asset_names": [a.name for a in created_assets],
    }


def create_images_zip(project_id: str, session: Session) -> bytes:
    """
    Nén N ảnh của dự án thành tệp ZIP để người dùng tải về nạp vào CVAT,
    kèm theo sẵn classes.txt và cvat_raw_labels.json để tiện khai báo labels.
    """
    project = session.get(Project, project_id)
    classes = project.classes if project else DEFAULT_CLASSES

    assets = session.exec(select(Asset).where(Asset.project_id == project_id)).all()
    if not assets:
        raise ValueError("Dự án chưa có ảnh nào.")

    zip_stream = io.BytesIO()
    with zipfile.ZipFile(zip_stream, "w", zipfile.ZIP_DEFLATED) as zf:
        for a in assets:
            path = STORAGE / a.storage_name
            if path.is_file():
                zf.write(path, arcname=a.name)

        # Đính kèm classes.txt (từng dòng)
        zf.writestr("classes.txt", "\n".join(classes) + "\n")

        # Đính kèm cvat_raw_labels.json (chuẩn CVAT raw format)
        cvat_labels = [{"name": c, "type": "any", "attributes": []} for c in classes]
        zf.writestr("cvat_raw_labels.json", json.dumps(cvat_labels, indent=2))

    return zip_stream.getvalue()


def validate_and_save_ai(
    project_id: str,
    raw_data: bytes,
    session: Session,
) -> dict:
    """
    Kiểm tra tính hợp lệ của tệp AI Pre-label tải lên từ Colab:
    - Kiểm tra cấu trúc JSON
    - Bắt buộc phải có 'inference_seconds' và giá trị phải > 0
    - Lưu vào CSDL
    """
    # 1. Giải mã JSON (trực tiếp hoặc từ tệp ZIP)
    data = None
    if raw_data.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(io.BytesIO(raw_data)) as zf:
                json_files = [n for n in zf.namelist() if n.endswith(".json") and not n.startswith("__MACOSX")]
                if not json_files:
                    raise ValueError("Tệp ZIP không chứa bất kỳ tệp .json nào.")
                pref = next(
                    (n for n in json_files if any(k in n.lower() for k in ["ai", "infer", "result", "pred", "instance"])),
                    json_files[0],
                )
                data = json.loads(zf.read(pref))
        except Exception as e:
            if isinstance(e, ValueError):
                raise
            raise ValueError(f"Không thể đọc tệp ZIP: {e}")
    else:
        try:
            data = json.loads(raw_data)
        except Exception:
            raise ValueError("Tệp tải lên không phải là định dạng JSON hợp lệ.")

    # 2. Kiểm tra trường thời gian suy luận
    inf_sec = None
    if isinstance(data, dict):
        if "inference_seconds" in data:
            inf_sec = data["inference_seconds"]
        elif "run" in data and isinstance(data["run"], dict) and "inference_seconds" in data["run"]:
            inf_sec = data["run"]["inference_seconds"]
        elif "inference_duration" in data:
            inf_sec = data["inference_duration"]
        elif "run" in data and isinstance(data["run"], dict) and "inference_duration" in data["run"]:
            inf_sec = data["run"]["inference_duration"]
        elif "time" in data:
            inf_sec = data["time"]
        elif "seconds" in data:
            inf_sec = data["seconds"]

    if inf_sec is None:
        raise ValueError(
            "Tệp AI không hợp lệ: Thiếu trường 'inference_seconds' ghi nhận thời gian suy luận từ mô hình Colab. "
            "Vui lòng dùng mã Colab có tích hợp đo thời gian!"
        )

    try:
        inf_sec_val = float(inf_sec)
    except (ValueError, TypeError):
        raise ValueError(f"Thời gian suy luận '{inf_sec}' không phải là con số hợp lệ.")

    if inf_sec_val <= 0:
        raise ValueError(
            f"Thời gian suy luận ({inf_sec_val}s) không hợp lệ! Thời gian chạy AI phải là số dương lớn hơn 0."
        )

    # 3. Đọc danh sách samples
    project = session.get(Project, project_id)
    if not project:
        raise ValueError("Không tìm thấy dự án.")

    samples_raw = data.get("samples") if isinstance(data, dict) else data
    if not samples_raw or not isinstance(samples_raw, list):
        raise ValueError("Tệp AI không chứa danh sách các mẫu ảnh ('samples').")

    # Bảng đồng nghĩa lớp (COCO -> BDD100K)
    synonym_map = {
        "greensm": "car",
        "vehicle": "car",
        "automobile": "car",
        "auto": "car",
        "person": "pedestrian",
        "stop sign": "traffic sign",
        "motorbike": "motorcycle",
        "bike": "bicycle",
    }

    project_assets = {a.name: a for a in session.exec(select(Asset).where(Asset.project_id == project_id)).all()}
    valid_samples = []

    for s in samples_raw:
        if not isinstance(s, dict):
            continue
        raw_name = s.get("asset_name") or s.get("name") or ""
        clean_name = Path(raw_name).name
        if not clean_name or clean_name not in project_assets:
            continue

        raw_objs = s.get("objects", s.get("labels", []))
        parsed_objs = []
        for o_idx, o in enumerate(raw_objs):
            cat_raw = str(o.get("category", "car")).lower().strip()
            cat = synonym_map.get(cat_raw, cat_raw)
            if cat not in project.classes:
                # Nếu không khớp lớp nào trong BDD100K thì bỏ qua
                continue

            geom = o.get("geometry")
            if geom and geom.get("kind") == "bbox2d":
                xyxy = geom.get("xyxy")
            elif "box2d" in o:
                b = o["box2d"]
                xyxy = [float(b.get("x1", 0)), float(b.get("y1", 0)), float(b.get("x2", 10)), float(b.get("y2", 10))]
            else:
                continue

            conf = float(o.get("confidence", 0.9)) if o.get("confidence") is not None else 0.9
            parsed_objs.append(
                ObjectLabel(
                    id=str(o.get("id") or f"ai-{clean_name}-{o_idx+1}"),
                    category=cat,
                    geometry=Box2D(kind="bbox2d", xyxy=(xyxy[0], xyxy[1], xyxy[2], xyxy[3])),
                    confidence=conf,
                )
            )

        valid_samples.append(
            SampleLabels(
                asset_name=clean_name,
                objects=parsed_objs,
                active_seconds=round(inf_sec_val / max(1, len(samples_raw)), 3),
            )
        )

    if not valid_samples:
        raise ValueError(
            "Không có mẫu ảnh nào trong tệp AI khớp với danh sách ảnh của dự án. "
            "Hãy kiểm tra lại tên các file ảnh trong tệp tải lên!"
        )

    bundle = LabelBundle(
        schema_version="1.0",
        task="detection_2d",
        name=f"AI Pre-label ({round(inf_sec_val, 2)}s)",
        annotator="AI Model (Colab)",
        parent_id=None,
        run=RunMetadata(
            model=data.get("model", "YOLO11m"),
            inference_seconds=round(inf_sec_val, 3),
        ),
        samples=valid_samples,
    )

    row = LabelSet(
        project_id=project_id,
        source="ai",
        name=f"AI Pre-label ({round(inf_sec_val, 2)}s)",
        annotator="AI Model (Colab)",
        parent_id=None,
        payload=bundle.model_dump(mode="json"),
    )
    session.add(row)
    session.commit()
    session.refresh(row)

    return {
        "status": "ok",
        "label_set_id": row.id,
        "inference_seconds": round(inf_sec_val, 3),
        "samples_count": len(valid_samples),
        "total_boxes": sum(len(s.objects) for s in valid_samples),
    }


def export_ai_as_cvat_coco(project_id: str, session: Session) -> bytes:
    """
    Xuất các hộp dự đoán AI sang định dạng COCO 1.0 (ZIP) để người dùng
    nạp thẳng vào CVAT làm khung sườn chỉnh sửa (Assisted mode).
    """
    ai_label = session.exec(
        select(LabelSet)
        .where(LabelSet.project_id == project_id, LabelSet.source == "ai")
        .order_by(LabelSet.created_at.desc())
    ).first()

    if not ai_label:
        raise ValueError("Dự án chưa có kết quả AI Pre-label nào.")

    payload = ai_label.payload
    project = session.get(Project, project_id)

    categories = [{"id": idx + 1, "name": c} for idx, c in enumerate(project.classes)]
    cat_to_id = {c["name"]: c["id"] for c in categories}

    images = []
    annotations = []
    ann_id = 1

    for img_idx, sample in enumerate(payload.get("samples", [])):
        img_id = img_idx + 1
        img_name = sample["asset_name"]
        images.append({
            "id": img_id,
            "file_name": img_name,
            "width": 1280,
            "height": 720,
        })

        for obj in sample.get("objects", []):
            xyxy = obj["geometry"]["xyxy"]
            x1, y1, x2, y2 = xyxy
            w = max(1.0, x2 - x1)
            h = max(1.0, y2 - y1)
            cat_name = obj.get("category", "car")
            cid = cat_to_id.get(cat_name, 1)

            annotations.append({
                "id": ann_id,
                "image_id": img_id,
                "category_id": cid,
                "bbox": [round(x1, 2), round(y1, 2), round(w, 2), round(h, 2)],
                "area": round(w * h, 2),
                "iscrowd": 0,
                "score": obj.get("confidence", 0.9),
            })
            ann_id += 1

    coco_data = {
        "images": images,
        "categories": categories,
        "annotations": annotations,
    }

    # Đóng gói thành file ZIP chứa annotations/instances_default.json
    zip_stream = io.BytesIO()
    with zipfile.ZipFile(zip_stream, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("annotations/instances_default.json", json.dumps(coco_data, ensure_ascii=False, indent=2))

    return zip_stream.getvalue()
