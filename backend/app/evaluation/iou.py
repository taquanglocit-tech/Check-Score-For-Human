def calculate_iou_2d(
    box_a: tuple[float, float, float, float] | list[float],
    box_b: tuple[float, float, float, float] | list[float],
) -> float:
    """
    Tính chỉ số Intersection over Union (IoU) giữa 2 bounding box 2D.
    Tọa độ đầu vào: (x1, y1, x2, y2).
    """
    x1_inter = max(box_a[0], box_b[0])
    y1_inter = max(box_a[1], box_b[1])
    x2_inter = min(box_a[2], box_b[2])
    y2_inter = min(box_a[3], box_b[3])

    # Chiều rộng và chiều cao phần giao
    w_inter = max(0.0, x2_inter - x1_inter)
    h_inter = max(0.0, y2_inter - y1_inter)
    area_inter = w_inter * h_inter

    if area_inter <= 0.0:
        return 0.0

    area_a = max(0.0, (box_a[2] - box_a[0]) * (box_a[3] - box_a[1]))
    area_b = max(0.0, (box_b[2] - box_b[0]) * (box_b[3] - box_b[1]))

    area_union = area_a + area_b - area_inter
    if area_union <= 0.0:
        return 0.0

    return float(area_inter / area_union)
