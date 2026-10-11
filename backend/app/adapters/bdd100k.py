import json
from pathlib import Path
from ..schemas import Box2D, LabelBundle, ObjectLabel, RunMetadata, SampleLabels


def parse_bdd100k_json(
    raw_data: list | dict,
    project_classes: list[str],
    task: str = "detection_2d",
    bundle_name: str = "BDD100K Import",
    source: str = "ground_truth",
    valid_assets: set[str] | None = None,
) -> LabelBundle:
    """
    Tự động chuyển đổi dữ liệu định dạng gốc BDD100K (danh sách các ảnh với labels[box2d])
    sang định dạng LabelBundle chuẩn của M49.
    """
    if isinstance(raw_data, dict):
        # Có thể là {"frames": [...]} hoặc {"samples": [...]}
        items = raw_data.get("frames", raw_data.get("samples", [raw_data]))
    elif isinstance(raw_data, list):
        items = raw_data
    else:
        raise ValueError("Dữ liệu BDD100K phải là một mảng JSON các khung hình.")

    classes_set = set(project_classes)
    samples: list[SampleLabels] = []
    seen_assets = set()

    for item in items:
        if not isinstance(item, dict):
            continue
        img_name = item.get("name")
        if not img_name:
            continue
        clean_name = Path(img_name).name

        # Nếu có danh sách ảnh trong dự án, chỉ lấy những ảnh đã upload vào dự án
        if valid_assets is not None and clean_name not in valid_assets:
            continue

        if clean_name in seen_assets:
            continue
        seen_assets.add(clean_name)

        raw_labels = item.get("labels", [])
        objects: list[ObjectLabel] = []

        for idx, lbl in enumerate(raw_labels):
            box2d = lbl.get("box2d")
            if not box2d:
                continue

            category = lbl.get("category", "car").strip()
            # Nếu category không nằm trong classes của dự án, bỏ qua hoặc lấy nếu hợp lệ
            if category not in classes_set:
                continue

            x1 = max(0.0, float(box2d.get("x1", 0)))
            y1 = max(0.0, float(box2d.get("y1", 0)))
            x2 = max(x1 + 1.0, float(box2d.get("x2", x1 + 10)))
            y2 = max(y1 + 1.0, float(box2d.get("y2", y1 + 10)))

            # Giới hạn kích thước ảnh chuẩn 1280x720 nếu tọa độ hơi vượt
            x1 = round(min(1280.0, x1), 2)
            y1 = round(min(720.0, y1), 2)
            x2 = round(max(x1 + 1.0, min(1280.0, x2)), 2)
            y2 = round(max(y1 + 1.0, min(720.0, y2)), 2)

            obj_id = str(lbl.get("id") or f"bdd-{clean_name}-{idx + 1}")
            confidence = float(lbl["confidence"]) if "confidence" in lbl else (1.0 if source == "ai" else None)

            objects.append(
                ObjectLabel(
                    id=obj_id,
                    category=category,
                    geometry=Box2D(kind="bbox2d", xyxy=(x1, y1, x2, y2)),
                    confidence=confidence,
                )
            )

        samples.append(
            SampleLabels(
                asset_name=clean_name,
                objects=objects,
                active_seconds=None,
            )
        )

    if not samples:
        raise ValueError(
            "Không tìm thấy mẫu ảnh nào khớp với các ảnh đã tải lên trong dự án. "
            "Hãy đảm bảo tên tệp ảnh trong JSON khớp với tên ảnh bạn đã tải lên!"
        )

    return LabelBundle(
        schema_version="1.0",
        task=task,
        name=bundle_name,
        annotator="BDD100K Importer",
        parent_id=None,
        run=RunMetadata(),
        samples=samples,
    )
