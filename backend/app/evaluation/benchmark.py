from .matcher import match_image_boxes


def evaluate_single_source(
    pred_bundle: dict,
    gt_bundle: dict,
    iou_threshold: float = 0.5,
) -> dict:
    """
    So sánh một bộ nhãn dự đoán (pred_bundle) với bộ nhãn chuẩn (gt_bundle)
    trên tất cả các ảnh có trong dự án.
    """
    gt_samples_map = {s["asset_name"]: s for s in gt_bundle.get("samples", [])}
    pred_samples_map = {s["asset_name"]: s for s in pred_bundle.get("samples", [])}

    all_matched = []
    all_fps = []
    all_fns = []

    class_stats: dict[str, dict] = {}
    per_image_results = []

    total_active_seconds = 0.0

    # Duyệt qua từng ảnh trong Ground Truth
    for asset_name, gt_sample in gt_samples_map.items():
        gt_objects = gt_sample.get("objects", [])
        pred_sample = pred_samples_map.get(asset_name, {"objects": [], "active_seconds": None})
        pred_objects = pred_sample.get("objects", [])

        if pred_sample.get("active_seconds"):
            total_active_seconds += float(pred_sample["active_seconds"])

        # Ghép cặp trên ảnh này
        res = match_image_boxes(pred_objects, gt_objects, iou_threshold=iou_threshold)
        all_matched.extend(res["matched"])
        all_fps.extend(res["fp"])
        all_fns.extend(res["fn"])

        per_image_results.append({
            "asset_name": asset_name,
            "matched_count": len(res["matched"]),
            "fp_count": len(res["fp"]),
            "fn_count": len(res["fn"]),
            "mean_iou": res["mean_iou"],
        })

        # Thống kê theo từng class
        for m in res["matched"]:
            c = m["gt"].get("category", "unknown")
            class_stats.setdefault(c, {"tp": 0, "fp": 0, "fn": 0, "ious": []})
            class_stats[c]["tp"] += 1
            class_stats[c]["ious"].append(m["iou"])

        for fp_obj in res["fp"]:
            c = fp_obj.get("category", "unknown")
            class_stats.setdefault(c, {"tp": 0, "fp": 0, "fn": 0, "ious": []})
            class_stats[c]["fp"] += 1

        for fn_obj in res["fn"]:
            c = fn_obj.get("category", "unknown")
            class_stats.setdefault(c, {"tp": 0, "fp": 0, "fn": 0, "ious": []})
            class_stats[c]["fn"] += 1

    # Nếu có ghi nhận thời gian ở cấp độ run metadata
    run_info = pred_bundle.get("run", {}) or {}
    if total_active_seconds == 0.0 and run_info.get("inference_seconds"):
        total_active_seconds = float(run_info["inference_seconds"])

    tp_count = len(all_matched)
    fp_count = len(all_fps)
    fn_count = len(all_fns)

    precision = round(tp_count / (tp_count + fp_count), 4) if (tp_count + fp_count) > 0 else 0.0
    recall = round(tp_count / (tp_count + fn_count), 4) if (tp_count + fn_count) > 0 else 0.0
    f1_score = round(2 * precision * recall / (precision + recall), 4) if (precision + recall) > 0 else 0.0
    mean_iou = round(sum(m["iou"] for m in all_matched) / tp_count, 4) if tp_count > 0 else 0.0
    mean_quality = round(sum(m["box_quality"] for m in all_matched) / tp_count, 4) if tp_count > 0 else 0.0

    num_samples = max(1, len(gt_samples_map))
    time_per_image = round(total_active_seconds / num_samples, 2)
    images_per_hour = round(3600.0 / time_per_image, 1) if time_per_image > 0 else 0.0

    # Tổng kết chi tiết từng class
    formatted_classes = {}
    for c_name, c_data in class_stats.items():
        c_tp = c_data["tp"]
        c_fp = c_data["fp"]
        c_fn = c_data["fn"]
        c_prec = round(c_tp / (c_tp + c_fp), 4) if (c_tp + c_fp) > 0 else 0.0
        c_rec = round(c_tp / (c_tp + c_fn), 4) if (c_tp + c_fn) > 0 else 0.0
        c_f1 = round(2 * c_prec * c_rec / (c_prec + c_rec), 4) if (c_prec + c_rec) > 0 else 0.0
        c_iou = round(sum(c_data["ious"]) / c_tp, 4) if c_tp > 0 else 0.0
        formatted_classes[c_name] = {
            "tp": c_tp,
            "fp": c_fp,
            "fn": c_fn,
            "precision": c_prec,
            "recall": c_rec,
            "f1": c_f1,
            "mean_iou": c_iou,
        }

    return {
        "tp": tp_count,
        "fp": fp_count,
        "fn": fn_count,
        "precision": precision,
        "recall": recall,
        "f1": f1_score,
        "mean_iou": mean_iou,
        "overall_quality": mean_quality,
        "total_seconds": round(total_active_seconds, 2),
        "time_per_image": time_per_image,
        "images_per_hour": images_per_hour,
        "classes": formatted_classes,
        "per_image": per_image_results,
    }


def compute_benchmark_comparison(
    gt_payload: dict,
    bundles: dict[str, dict],
    iou_threshold: float = 0.5,
) -> dict:
    """
    So sánh đối đầu giữa 3 phương pháp: manual, ai, và assisted.
    """
    results = {}
    for source in ["manual", "ai", "assisted"]:
        if source in bundles and bundles[source]:
            results[source] = evaluate_single_source(
                bundles[source],
                gt_payload,
                iou_threshold=iou_threshold,
            )

    # Tính toán chỉ số tiết kiệm công sức (Effort Saved) và tăng tốc (Speedup)
    tradeoff = {}
    manual_res = results.get("manual")
    assisted_res = results.get("assisted")

    if manual_res and assisted_res and manual_res["total_seconds"] > 0:
        man_sec = manual_res["total_seconds"]
        ast_sec = assisted_res["total_seconds"]
        effort_saved = round((1.0 - ast_sec / man_sec) * 100.0, 1)
        speedup = round(man_sec / max(0.1, ast_sec), 2)
        tradeoff = {
            "effort_saved_percent": effort_saved,
            "speedup_factor": speedup,
            "time_saved_seconds": round(man_sec - ast_sec, 2),
        }

    return {
        "methods": results,
        "tradeoff": tradeoff,
        "iou_threshold": iou_threshold,
    }
