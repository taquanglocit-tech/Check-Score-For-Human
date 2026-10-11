from .iou import calculate_iou_2d

try:
    import numpy as np
    from scipy.optimize import linear_sum_assignment

    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False

# Các nhóm lớp ngữ nghĩa tương đồng trong BDD100K
SEMANTIC_GROUPS = [
    {"car", "truck", "bus", "train"},
    {"motorcycle", "bicycle"},
    {"pedestrian", "rider"},
    {"traffic sign", "traffic light"},
]


def get_semantic_similarity(cat_a: str, cat_b: str) -> float:
    """
    Tính điểm tương đồng ngữ nghĩa S_AB:
    - Nếu đúng hoàn toàn lớp: 1.0
    - Nếu nhầm trong cùng nhóm phương tiện (ví dụ car <-> truck): 0.7 (sửa nhanh)
    - Nếu nhầm khác nhóm (ví dụ car <-> pedestrian): 0.2 (phạt nặng)
    """
    cat_a_lower = cat_a.lower().strip()
    cat_b_lower = cat_b.lower().strip()

    if cat_a_lower == cat_b_lower:
        return 1.0

    for group in SEMANTIC_GROUPS:
        if cat_a_lower in group and cat_b_lower in group:
            return 0.7

    return 0.2


def match_image_boxes(
    preds: list[dict],
    gts: list[dict],
    iou_threshold: float = 0.5,
) -> dict:
    """
    Ghép cặp giữa tập hộp dự đoán (preds) và tập nhãn chuẩn (gts) của 1 ảnh.
    Sử dụng thuật toán Hungarian (scipy) hoặc Greedy matching (fallback).
    """
    num_preds = len(preds)
    num_gts = len(gts)

    if num_preds == 0 and num_gts == 0:
        return {"matched": [], "fp": [], "fn": [], "mean_iou": 0.0}

    if num_preds == 0:
        return {"matched": [], "fp": [], "fn": gts, "mean_iou": 0.0}

    if num_gts == 0:
        return {"matched": [], "fp": preds, "fn": [], "mean_iou": 0.0}

    # 1. Tính ma trận IoU
    iou_matrix = []
    for p in preds:
        p_xyxy = p.get("geometry", {}).get("xyxy")
        row = []
        for g in gts:
            g_xyxy = g.get("geometry", {}).get("xyxy")
            if p_xyxy and g_xyxy:
                row.append(calculate_iou_2d(p_xyxy, g_xyxy))
            else:
                row.append(0.0)
        iou_matrix.append(row)

    matched_pairs = []
    matched_pred_indices = set()
    matched_gt_indices = set()

    # 2. Ghép cặp tối ưu
    if HAS_SCIPY:
        np_iou = np.array(iou_matrix)
        cost_matrix = 1.0 - np_iou
        row_ind, col_ind = linear_sum_assignment(cost_matrix)

        for r, c in zip(row_ind, col_ind):
            iou_val = float(np_iou[r, c])
            if iou_val >= iou_threshold:
                p_obj = preds[r]
                g_obj = gts[c]
                s_ab = get_semantic_similarity(p_obj.get("category", ""), g_obj.get("category", ""))
                matched_pairs.append({
                    "pred": p_obj,
                    "gt": g_obj,
                    "iou": round(iou_val, 4),
                    "semantic_score": s_ab,
                    "box_quality": round(iou_val * s_ab, 4),
                })
                matched_pred_indices.add(r)
                matched_gt_indices.add(c)
    else:
        # Thuật toán Greedy matching nếu môi trường chưa cài scipy
        candidates = []
        for i in range(num_preds):
            for j in range(num_gts):
                candidates.append((iou_matrix[i][j], i, j))
        candidates.sort(key=lambda x: x[0], reverse=True)

        for iou_val, r, c in candidates:
            if iou_val < iou_threshold:
                break
            if r not in matched_pred_indices and c not in matched_gt_indices:
                p_obj = preds[r]
                g_obj = gts[c]
                s_ab = get_semantic_similarity(p_obj.get("category", ""), g_obj.get("category", ""))
                matched_pairs.append({
                    "pred": p_obj,
                    "gt": g_obj,
                    "iou": round(float(iou_val), 4),
                    "semantic_score": s_ab,
                    "box_quality": round(float(iou_val) * s_ab, 4),
                })
                matched_pred_indices.add(r)
                matched_gt_indices.add(c)

    # 3. Phân loại FP và FN
    fp = [preds[i] for i in range(num_preds) if i not in matched_pred_indices]
    fn = [gts[j] for j in range(num_gts) if j not in matched_gt_indices]

    mean_iou = (
        round(sum(m["iou"] for m in matched_pairs) / len(matched_pairs), 4)
        if matched_pairs
        else 0.0
    )

    return {
        "matched": matched_pairs,
        "fp": fp,
        "fn": fn,
        "mean_iou": mean_iou,
    }
