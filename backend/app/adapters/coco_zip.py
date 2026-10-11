import io
import json
import zipfile
from pathlib import Path
from uuid import uuid4

from ..schemas import Box2D, LabelBundle, ObjectLabel, RunMetadata, SampleLabels


def parse_cvat_coco_zip(
    zip_bytes: bytes,
    task: str = "detection_2d",
    bundle_name: str = "CVAT COCO Import",
    annotator: str | None = None,
    parent_id: str | None = None,
    source: str = "manual",
    total_seconds: float | None = None,
) -> LabelBundle:
    """
    Đọc tệp ZIP xuất từ CVAT (định dạng COCO 1.0) trực tiếp trong bộ nhớ (RAM),
    tự động tìm tệp instances_default.json và chuyển đổi thành đối tượng LabelBundle
    chuẩn của hệ thống M49.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile:
        raise ValueError("Tệp tải lên không phải là tệp ZIP hợp lệ.")

    # 1. Tìm tệp JSON annotations trong tệp ZIP
    # CVAT thường lưu tại annotations/instances_default.json hoặc instances_default.json
    json_filename = None
    for name in archive.namelist():
        if name.endswith(".json") and not name.startswith("__MACOSX"):
            json_filename = name
            if "instances" in name.lower():
                break  # Ưu tiên tệp có chữ instances

    if not json_filename:
        raise ValueError("Không tìm thấy tệp JSON chứa nhãn (ví dụ: instances_default.json) bên trong tệp ZIP.")

    with archive.open(json_filename) as f:
        try:
            coco_data = json.load(f)
        except json.JSONDecodeError:
            raise ValueError(f"Không thể đọc nội dung JSON từ tệp {json_filename}.")

    # 2. Kiểm tra cấu trúc cơ bản của COCO
    if not isinstance(coco_data, dict) or "images" not in coco_data or "annotations" not in coco_data:
        raise ValueError("Cấu trúc tệp JSON không đúng định dạng COCO (thiếu images hoặc annotations).")

    # 3. Tạo bảng tra cứu danh mục lớp (categories)
    cat_map: dict[int, str] = {}
    for cat in coco_data.get("categories", []):
        cat_map[cat["id"]] = cat.get("name", "unknown").strip()

    # 4. Gom các annotations theo image_id
    annotations_by_image: dict[int, list[dict]] = {}
    for ann in coco_data.get("annotations", []):
        img_id = ann.get("image_id")
        if img_id is not None:
            annotations_by_image.setdefault(img_id, []).append(ann)

    # 5. Phân bổ thời gian (active_seconds) nếu người dùng có bấm giờ
    images_list = coco_data.get("images", [])
    num_images = max(1, len(images_list))
    per_image_seconds = round(total_seconds / num_images, 2) if total_seconds is not None else None

    # 6. Chuyển đổi từng ảnh và danh sách bounding box sang chuẩn M49
    samples: list[SampleLabels] = []
    seen_assets = set()

    for img_info in images_list:
        raw_name = img_info.get("file_name", "")
        # Chỉ lấy tên file gốc (ví dụ "001.jpg"), loại bỏ thư mục tiền tố
        clean_name = Path(raw_name).name
        if not clean_name or clean_name in seen_assets:
            continue
        seen_assets.add(clean_name)

        img_id = img_info.get("id")
        raw_anns = annotations_by_image.get(img_id, [])

        objects: list[ObjectLabel] = []
        for ann_idx, ann in enumerate(raw_anns):
            bbox = ann.get("bbox", [])
            if len(bbox) != 4:
                continue

            x, y, w, h = bbox
            x1 = max(0.0, float(x))
            y1 = max(0.0, float(y))
            x2 = max(x1 + 0.1, float(x + w))
            y2 = max(y1 + 0.1, float(y + h))

            cat_id = ann.get("category_id")
            category_name = cat_map.get(cat_id, "unknown")

            # ID duy nhất cho mỗi object trong sample
            obj_id = str(ann.get("id") or f"obj-{ann_idx + 1}")

            confidence = None
            if source == "ai":
                confidence = float(ann.get("score", 1.0))

            objects.append(
                ObjectLabel(
                    id=obj_id,
                    category=category_name,
                    geometry=Box2D(kind="bbox2d", xyxy=(round(x1, 2), round(y1, 2), round(x2, 2), round(y2, 2))),
                    confidence=confidence,
                )
            )

        samples.append(
            SampleLabels(
                asset_name=clean_name,
                objects=objects,
                active_seconds=per_image_seconds,
            )
        )

    if not samples:
        raise ValueError("Không có mẫu ảnh nào hợp lệ được tìm thấy trong tệp COCO.")

    run_meta = RunMetadata(
        inference_seconds=total_seconds if source == "ai" else None,
    )

    return LabelBundle(
        schema_version="1.0",
        task=task,
        name=bundle_name,
        annotator=annotator,
        parent_id=parent_id,
        run=run_meta,
        samples=samples,
    )
