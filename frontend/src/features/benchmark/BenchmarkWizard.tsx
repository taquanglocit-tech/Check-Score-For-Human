import { useEffect, useRef, useState } from 'react';
import { api, postJSON, uploadZip } from '../../api';
import type { Asset, LabelSet, Project } from '../../types';

function formatDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function BenchmarkWizard({
  project,
  labels,
  onProjectCreated,
  onRefresh,
  onViewResults,
}: {
  project?: Project;
  assets: Asset[];
  labels: LabelSet[];
  onProjectCreated: (newProjectId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onViewResults: () => void;
}) {
  const [step, setStep] = useState(1);
  const [sampleCount, setSampleCount] = useState(10);
  const [projName, setProjName] = useState('BDD100K Benchmark Mẫu');
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Đồng hồ Bước 2: Vẽ tay (Manual)
  const [manSec, setManSec] = useState(0);
  const [manRunning, setManRunning] = useState(false);
  const manTimerRef = useRef<number | null>(null);

  // Đồng hồ Bước 4: Sửa nhãn AI (Assisted)
  const [astSec, setAstSec] = useState(0);
  const [astRunning, setAstRunning] = useState(false);
  const astTimerRef = useRef<number | null>(null);

  const [aiInferenceInfo, setAiInferenceInfo] = useState<{ seconds: number; samples: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedCvat, setCopiedCvat] = useState<'json' | 'text' | null>(null);

  const cvatClasses = [
    { name: 'car', color: '#10b981' },
    { name: 'pedestrian', color: '#ef4444' },
    { name: 'traffic sign', color: '#f59e0b' },
    { name: 'traffic light', color: '#06b6d4' },
    { name: 'truck', color: '#8b5cf6' },
    { name: 'bus', color: '#3b82f6' },
    { name: 'rider', color: '#f97316' },
    { name: 'motorcycle', color: '#ec4899' },
    { name: 'bicycle', color: '#84cc16' },
  ];

  // Timer Manual
  useEffect(() => {
    if (manRunning) {
      manTimerRef.current = window.setInterval(() => setManSec(s => s + 1), 1000);
    } else if (manTimerRef.current) {
      clearInterval(manTimerRef.current);
    }
    return () => { if (manTimerRef.current) clearInterval(manTimerRef.current); };
  }, [manRunning]);

  // Timer Assisted
  useEffect(() => {
    if (astRunning) {
      astTimerRef.current = window.setInterval(() => setAstSec(s => s + 1), 1000);
    } else if (astTimerRef.current) {
      clearInterval(astTimerRef.current);
    }
    return () => { if (astTimerRef.current) clearInterval(astTimerRef.current); };
  }, [astRunning]);

  const hasGt = labels.some(l => l.source === 'ground_truth');
  const hasMan = labels.some(l => l.source === 'manual');
  const hasAi = labels.some(l => l.source === 'ai');
  const hasAst = labels.some(l => l.source === 'assisted');

  // Bước 1: Khởi tạo đợt thử nghiệm chia mẫu
  async function handleSplitSample() {
    setLoading(true);
    setStatusMsg({ text: 'Đang trích xuất ảnh và tạo bộ nhãn Ground Truth tĩnh…', type: 'info' });
    try {
      const res = await postJSON<{ project_id: string; sample_count: number }>(
        '/benchmark/split',
        { project_name: projName, sample_count: sampleCount }
      );
      await onProjectCreated(res.project_id);
      setStatusMsg({
        text: `Đã khởi tạo đợt thử nghiệm với ${res.sample_count} ảnh BDD100K mẫu.`,
        type: 'success',
      });
      setStep(1); // Ở lại bước 1 để tải zip ảnh về
    } catch (e) {
      setStatusMsg({ text: `Lỗi: ${String(e)}`, type: 'error' });
    } finally {
      setLoading(false);
    }
  }

  // Tải gói ảnh zip để nạp vào CVAT
  function handleDownloadImagesZip() {
    if (!project) return;
    window.open(`/api/benchmark/download-images/${project.id}`, '_blank');
  }

  // Tải gói pre-label zip để nạp vào CVAT sửa
  function handleDownloadCvatPrelabel() {
    if (!project) return;
    window.open(`/api/benchmark/cvat-prelabel/${project.id}`, '_blank');
  }

  // Bước 2: Nạp Task_Manual.zip từ CVAT
  async function handleUploadManualZip(file: File) {
    if (!project) return;
    setLoading(true);
    setStatusMsg({ text: 'Đang giải nén và kiểm tra tệp Task_Manual.zip từ CVAT…', type: 'info' });
    try {
      await uploadZip(`/projects/${project.id}/imports-zip/manual`, file, {
        annotator: 'SinhVien_Manual',
        total_seconds: manSec,
      });
      setManRunning(false);
      setStatusMsg({
        text: `Hoàn thành Bước 2: Đã lưu nhãn thủ công (${manSec} giây, trung bình ${(manSec / sampleCount).toFixed(1)}s/ảnh).`,
        type: 'success',
      });
      await onRefresh();
      setStep(3); // Chuyển sang Bước 3
    } catch (e) {
      setStatusMsg({ text: `Lỗi khi nạp nhãn thủ công: ${String(e)}`, type: 'error' });
    } finally {
      setLoading(false);
    }
  }

  // Bước 3: Nạp và kiểm tra tệp AI Pre-label từ Colab
  async function handleUploadAiFile(file: File) {
    if (!project) return;
    setLoading(true);
    setStatusMsg({ text: 'Đang kiểm tra tính hợp lệ và thời gian suy luận trong tệp AI…', type: 'info' });
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api<{ inference_seconds: number; samples_count: number }>(
        `/benchmark/validate-ai/${project.id}`,
        { method: 'POST', body: formData }
      );
      setAiInferenceInfo({ seconds: res.inference_seconds, samples: res.samples_count });
      setStatusMsg({
        text: `Tệp AI hợp lệ: Hoàn thành ${res.samples_count} ảnh trong ${res.inference_seconds} giây (${(res.samples_count / res.inference_seconds).toFixed(1)} ảnh/giây).`,
        type: 'success',
      });
      await onRefresh();
      setStep(4); // Chuyển sang Bước 4
    } catch (e) {
      setStatusMsg({ text: `Lỗi kiểm tra tệp AI: ${String(e)}`, type: 'error' });
    } finally {
      setLoading(false);
    }
  }

  // Bước 4: Nạp Task_Assisted.zip từ CVAT
  async function handleUploadAssistedZip(file: File) {
    if (!project) return;
    setLoading(true);
    setStatusMsg({ text: 'Đang giải nén và kiểm tra tệp Task_Assisted.zip từ CVAT…', type: 'info' });
    try {
      const aiParent = labels.find(l => l.source === 'ai')?.id;
      await uploadZip(`/projects/${project.id}/imports-zip/assisted`, file, {
        annotator: 'SinhVien_Assisted',
        parent_id: aiParent,
        total_seconds: astSec,
      });
      setAstRunning(false);
      setStatusMsg({
        text: `Hoàn thành Bước 4: Đã lưu nhãn hiệu chỉnh (${astSec} giây, trung bình ${(astSec / sampleCount).toFixed(1)}s/ảnh).`,
        type: 'success',
      });
      await onRefresh();
      setStep(5); // Chuyển sang Dashboard
    } catch (e) {
      setStatusMsg({ text: `Lỗi khi nạp nhãn hiệu chỉnh: ${String(e)}`, type: 'error' });
    } finally {
      setLoading(false);
    }
  }

  const stepsList = [
    { num: 1, title: 'Bước 1: Chọn mẫu dữ liệu', done: Boolean(project && hasGt) },
    { num: 2, title: 'Bước 2: Gán nhãn thủ công', done: hasMan },
    { num: 3, title: 'Bước 3: Chạy mô hình AI', done: hasAi },
    { num: 4, title: 'Bước 4: Hiệu chỉnh nhãn AI', done: hasAst },
    { num: 5, title: 'Bước 5: Đánh giá kết quả', done: hasMan && hasAi && hasAst },
  ];

  return (
    <div style={{ display: 'grid', gap: '20px' }}>
      {/* THANH TIẾN TRÌNH STEPPER */}
      <div style={{ display: 'flex', gap: '8px', background: 'white', padding: '12px 16px', borderRadius: '12px', border: '1px solid #e2e8f0', overflowX: 'auto' }}>
        {stepsList.map(s => {
          const isActive = step === s.num;
          return (
            <button
              key={s.num}
              type="button"
              onClick={() => setStep(s.num)}
              style={{
                flex: 1,
                minWidth: '140px',
                padding: '10px 14px',
                borderRadius: '8px',
                border: isActive ? '2px solid #0f766e' : '1px solid #e2e8f0',
                background: isActive ? '#f0fdf4' : s.done ? '#f8fafc' : 'white',
                color: isActive ? '#0f766e' : s.done ? '#16a34a' : '#64748b',
                fontWeight: isActive ? 700 : 600,
                fontSize: '13px',
                textAlign: 'center',
                cursor: 'pointer',
              }}
            >
              {s.done ? '✓ ' : ''}{s.title}
            </button>
          );
        })}
      </div>

      {/* THÔNG BÁO TRẠNG THÁI */}
      {statusMsg && (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: '8px',
            fontWeight: 600,
            fontSize: '14px',
            background: statusMsg.type === 'success' ? '#dcfce7' : statusMsg.type === 'error' ? '#fee2e2' : '#e0f2fe',
            color: statusMsg.type === 'success' ? '#166534' : statusMsg.type === 'error' ? '#991b1b' : '#075985',
            border: `1px solid ${statusMsg.type === 'success' ? '#bbf7d0' : statusMsg.type === 'error' ? '#fecaca' : '#bae6fd'}`,
          }}
        >
          {statusMsg.text}
        </div>
      )}

      {/* BƯỚC 1: CHỌN SỐ ẢNH & TẢI GÓI ZIP */}
      {step === 1 && (
        <section className="panel" style={{ borderLeft: '4px solid #0f766e' }}>
          <h2>Bước 1: Chọn số lượng ảnh thử nghiệm và tải về</h2>
          <p className="muted">
            Hệ thống cung cấp sẵn tập ảnh mẫu và Ground Truth BDD100K chuẩn hóa. Lựa chọn quy mô mẫu và tải gói ảnh (.zip) để nạp vào công cụ CVAT.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', margin: '20px 0' }}>
            <label>
              Tên đợt thử nghiệm:
              <input value={projName} onChange={e => setProjName(e.target.value)} placeholder="BDD100K Benchmark Test 1" />
            </label>
            <label>
              Số lượng ảnh thử nghiệm:
              <select value={sampleCount} onChange={e => setSampleCount(Number(e.target.value))}>
                <option value={5}>5 ảnh (Thử nghiệm nhanh)</option>
                <option value={10}>10 ảnh (Bộ mẫu chuẩn)</option>
              </select>
            </label>
          </div>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <button disabled={loading} onClick={() => void handleSplitSample()} style={{ background: '#0f766e' }}>
              Khởi tạo đợt thử nghiệm ({sampleCount} ảnh)
            </button>
            {project && (
              <button disabled={loading} onClick={handleDownloadImagesZip} style={{ background: '#0284c7' }}>
                Tải gói ảnh (.zip)
              </button>
            )}
            {project && hasGt && (
              <button onClick={() => setStep(2)} className="secondary" style={{ border: '1px solid #cbd5e1' }}>
                Chuyển sang Bước 2 (Gán nhãn thủ công) →
              </button>
            )}
          </div>

          {/* HỘP RAW LABELS CHO CVAT */}
          <div style={{ marginTop: '20px', background: '#f8fafc', padding: '16px', borderRadius: '10px', border: '1px solid #e2e8f0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
              <div>
                <strong style={{ color: '#0f172a', fontSize: '14px' }}>Danh mục nhãn đối tượng (Classes / Labels):</strong>
                <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#64748b' }}>
                  Khai báo danh sách nhãn khi tạo Task trên CVAT. Bạn có thể sao chép nhanh định dạng bên dưới:
                </p>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => {
                    const rawJson = JSON.stringify(
                      cvatClasses.map(c => ({ name: c.name, type: 'any', color: c.color, attributes: [] })),
                      null,
                      2
                    );
                    navigator.clipboard.writeText(rawJson);
                    setCopiedCvat('json');
                    setTimeout(() => setCopiedCvat(null), 2000);
                  }}
                  style={{ fontSize: '12px', padding: '6px 12px', background: copiedCvat === 'json' ? '#16a34a' : '#0f766e' }}
                >
                  {copiedCvat === 'json' ? 'Đã sao chép JSON' : 'Sao chép Raw JSON'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const txt = cvatClasses.map(c => c.name).join('\n');
                    navigator.clipboard.writeText(txt);
                    setCopiedCvat('text');
                    setTimeout(() => setCopiedCvat(null), 2000);
                  }}
                  className="secondary"
                  style={{ fontSize: '12px', padding: '6px 12px', border: '1px solid #cbd5e1' }}
                >
                  {copiedCvat === 'text' ? 'Đã sao chép Text' : 'Sao chép danh sách văn bản'}
                </button>
              </div>
            </div>

            {/* DANH SÁCH PILL BADGES */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
              {cvatClasses.map(c => (
                <span
                  key={c.name}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '4px 10px',
                    borderRadius: '20px',
                    fontSize: '12px',
                    fontWeight: 600,
                    background: 'white',
                    border: '1px solid #cbd5e1',
                    color: '#1e293b',
                  }}
                >
                  <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: c.color }} />
                  {c.name}
                </span>
              ))}
            </div>

            <div style={{ fontSize: '12px', color: '#0369a1', background: '#e0f2fe', padding: '8px 12px', borderRadius: '6px', border: '1px solid #bae6fd' }}>
              <strong>Hướng dẫn trên CVAT:</strong> Khi tạo Task → tại mục <strong>Setup labels</strong> → chọn tab <strong>Raw</strong> → dán chuỗi JSON đã sao chép → chọn <strong>Done</strong>.
            </div>
          </div>
        </section>
      )}

      {/* BƯỚC 2: VẼ TAY TRÊN CVAT (MANUAL) */}
      {step === 2 && (
        <section className="panel" style={{ borderLeft: '4px solid #d97706' }}>
          <h2>Bước 2: Gán nhãn thủ công trên CVAT (Manual Baseline)</h2>
          <p className="muted">
            1. Mở CVAT, tạo Task mới và tải tệp zip ảnh nhận từ Bước 1.<br />
            2. Bấm <strong>Bắt đầu</strong> ở đồng hồ bên dưới, thực hiện gán nhãn thủ công không có gợi ý từ mô hình.<br />
            3. Xuất Task ở định dạng <strong>COCO 1.0</strong> (tệp <code>Task_Manual.zip</code>) và tải lên ô phía dưới.
          </p>

          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', padding: '20px', borderRadius: '10px', margin: '20px 0', textAlign: 'center' }}>
            <span style={{ fontSize: '13px', color: '#92400e', fontWeight: 600 }}>Thời gian thực hiện thủ công</span>
            <div style={{ fontSize: '42px', fontWeight: 'bold', fontFamily: 'monospace', color: '#b45309', margin: '10px 0' }}>
              {formatDuration(manSec)}
            </div>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
              <button disabled={manRunning} onClick={() => setManRunning(true)} style={{ background: '#d97706' }}>Bắt đầu</button>
              <button disabled={!manRunning} onClick={() => setManRunning(false)} className="secondary">Tạm dừng</button>
              <button onClick={() => { setManRunning(false); setManSec(0); }} className="secondary">Đặt lại</button>
            </div>
          </div>

          <label className="drop" style={{ background: 'white', border: '2px dashed #d97706' }}>
            <span style={{ fontWeight: 600, color: '#92400e' }}>Tải lên tệp Task_Manual.zip (Định dạng COCO 1.0 từ CVAT)</span>
            <input
              disabled={loading}
              type="file"
              accept=".zip"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) void handleUploadManualZip(f);
                e.target.value = '';
              }}
            />
          </label>
          <div style={{ marginTop: '12px', fontSize: '13px', color: '#64748b' }}>
            Tệp mẫu thử nghiệm nhanh: <code>sample_cvat_manual.zip</code> trong thư mục <code>Downloads\New folder</code>.
          </div>
        </section>
      )}

      {/* BƯỚC 3: CHẠY AI PRE-LABEL TRÊN COLAB (XÁC THỰC THỜI GIAN) */}
      {step === 3 && (
        <section className="panel" style={{ borderLeft: '4px solid #dc2626' }}>
          <h2>Bước 3: Gán nhãn tự động bằng mô hình AI (AI-Only)</h2>
          <p className="muted">
            Chạy mô hình (YOLOv8/YOLO11) trên Google Colab để lấy dự đoán bounding box ban đầu.<br />
            Hệ thống sẽ tự động xác thực trường <code>inference_seconds</code> ghi nhận thời gian suy luận từ tệp kết quả.
          </p>

          <div style={{ background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0', margin: '16px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: '#334155' }}>Mã Python chạy trên Google Colab:</span>
              <button
                type="button"
                onClick={() => {
                  const code = `# ==============================================================================
# PIPELINE PRE-LABEL GOOGLE COLAB (YOLO11m)
# Tự động cài đặt thư viện, suy luận mô hình, đo thời gian và xuất tệp JSON
# ==============================================================================

# 1. Cài đặt thư viện cần thiết
!pip install -q ultralytics Pillow

import os, io, time, json, shutil, zipfile
from PIL import Image
from google.colab import files
from ultralytics import YOLO

# 2. Chuẩn bị thư mục dữ liệu
THU_MUC_ANH = "dataset/images"
if os.path.exists("dataset"):
    shutil.rmtree("dataset")
os.makedirs(THU_MUC_ANH, exist_ok=True)

# 3. Nạp mô hình YOLO11m
print("Đang nạp trọng số mô hình YOLO11m...")
model = YOLO("yolo11m.pt")
CONFIDENCE = 0.25

# 4. Tải dữ liệu ảnh từ người dùng
print("\\n" + "="*60)
print("CHỌN TỆP DỮ LIỆU ĐẦU VÀO TỪ BƯỚC 1:")
print(" - Tải lên 1 tệp nén .zip chứa ảnh")
print(" - Hoặc tải lên nhiều tệp ảnh .jpg/.png đồng thời")
print("="*60)

uploaded = files.upload()

for filename, content in uploaded.items():
    if filename.lower().endswith(".zip"):
        print(f"Đang giải nén: {filename}...")
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            for member in zf.namelist():
                if member.lower().endswith((".jpg", ".jpeg", ".png", ".bmp", ".webp")) and not member.startswith("__MACOSX"):
                    clean_name = os.path.basename(member)
                    if clean_name:
                        with open(os.path.join(THU_MUC_ANH, clean_name), "wb") as f_out:
                            f_out.write(zf.read(member))
    elif filename.lower().endswith((".jpg", ".jpeg", ".png", ".bmp", ".webp")):
        with open(os.path.join(THU_MUC_ANH, filename), "wb") as f:
            f.write(content)

danh_sach_anh = sorted([
    f for f in os.listdir(THU_MUC_ANH) 
    if f.lower().endswith((".jpg", ".jpeg", ".png", ".bmp", ".webp"))
])

if not danh_sach_anh:
    raise ValueError("Không tìm thấy tệp ảnh hợp lệ. Vui lòng chạy lại và tải lên tệp ảnh hoặc file zip.")

print(f"\\nĐã nhận diện {len(danh_sach_anh)} ảnh. Bắt đầu đo thời gian suy luận...")

# 5. ĐO THỜI GIAN VÀ SUY LUẬN MÔ HÌNH
start_time = time.time()
samples = []
tong_so_box = 0

for filename in danh_sach_anh:
    img_path = os.path.join(THU_MUC_ANH, filename)
    results = model.predict(source=img_path, conf=CONFIDENCE, verbose=False)
    
    objects = []
    for r in results:
        if r.boxes is None: continue
        for b_idx, box in enumerate(r.boxes):
            cls_id = int(box.cls[0].item())
            cat_name = model.names.get(cls_id, "car") if hasattr(model, 'names') else "car"
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            conf = float(box.conf[0].item())
            objects.append({
                "id": f"ai-{filename}-{b_idx+1}",
                "category": cat_name,
                "geometry": {
                    "kind": "bbox2d",
                    "xyxy": [round(x1, 2), round(y1, 2), round(x2, 2), round(y2, 2)]
                },
                "confidence": round(conf, 3)
            })
            tong_so_box += 1
    samples.append({"asset_name": filename, "objects": objects})

# 6. KẾT THÚC ĐO THỜI GIAN VÀ XUẤT TỆP
inference_seconds = round(time.time() - start_time, 3)
out_payload = {
    "schema_version": "1.0",
    "task": "detection_2d",
    "name": "YOLO11m Pre-label Colab",
    "inference_seconds": inference_seconds,
    "run": {
        "model": "YOLO11m",
        "inference_seconds": inference_seconds
    },
    "samples": samples
}

output_file = "ai_prelabel_result.json"
with open(output_file, "w", encoding="utf-8") as f:
    json.dump(out_payload, f, indent=2, ensure_ascii=False)

print(f"\\nHoàn tất suy luận: {inference_seconds} giây ({len(samples)} ảnh, {tong_so_box} bounding boxes).")
print("Đang tải xuống tệp kết quả ai_prelabel_result.json...")
files.download(output_file)`;
                  navigator.clipboard.writeText(code);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                style={{ fontSize: '12px', padding: '6px 12px', background: copied ? '#16a34a' : '#0284c7' }}
              >
                {copied ? 'Đã sao chép' : 'Sao chép mã Colab'}
              </button>
            </div>
            <pre style={{ background: '#1e293b', color: '#f8fafc', padding: '12px', borderRadius: '6px', fontSize: '11px', overflowX: 'auto', margin: 0, maxHeight: '200px' }}>
{`# Pipeline xử lý trọn gói trên Google Colab:
# 1. Cài đặt ultralytics và tải mô hình YOLO11m
# 2. Nhận tệp zip ảnh từ Bước 1 và giải nén tự động
# 3. Đo lường thời gian suy luận (inference_seconds)
# 4. Xuất định dạng JSON chuẩn hóa và tự động tải xuống`}
            </pre>
          </div>

          <label className="drop" style={{ background: 'white', border: '2px dashed #dc2626' }}>
            <span style={{ fontWeight: 600, color: '#b91c1c' }}>Tải lên tệp ai_prelabel_result.json từ Colab</span>
            <input
              disabled={loading}
              type="file"
              accept=".json,.zip"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) void handleUploadAiFile(f);
                e.target.value = '';
              }}
            />
          </label>

          <div style={{ marginTop: '12px', fontSize: '13px', color: '#64748b' }}>
            Tệp mẫu thử nghiệm nhanh: <code>ai_prelabel_result.json</code> trong thư mục <code>Downloads\New folder</code>.
          </div>

          {hasAi && (
            <div style={{ marginTop: '20px', display: 'flex', gap: '12px', alignItems: 'center' }}>
              <button onClick={handleDownloadCvatPrelabel} style={{ background: '#0284c7' }}>
                Tải gói Pre-label (.zip) để nạp vào CVAT
              </button>
              <button onClick={() => setStep(4)} className="secondary">
                Chuyển sang Bước 4 (Hiệu chỉnh nhãn AI) →
              </button>
            </div>
          )}
        </section>
      )}

      {/* BƯỚC 4: SỬA NHÃN AI TRÊN CVAT (ASSISTED) */}
      {step === 4 && (
        <section className="panel" style={{ borderLeft: '4px solid #0284c7' }}>
          <h2>Bước 4: Hiệu chỉnh nhãn AI trên CVAT (AI-Assisted)</h2>
          <p className="muted">
            1. Nạp tệp Pre-label ở Bước 3 vào CVAT (hộp dự đoán của AI sẽ hiển thị sẵn trên giao diện).<br />
            2. Bấm <strong>Bắt đầu</strong> ở đồng hồ bên dưới, thực hiện nắn chỉnh hộp sai lệch, xóa bounding box dư thừa và vẽ bù đối tượng còn thiếu.<br />
            3. Xuất Task ở định dạng <strong>COCO 1.0</strong> (tệp <code>Task_Assisted.zip</code>) và tải lên ô phía dưới.
          </p>

          <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', padding: '20px', borderRadius: '10px', margin: '20px 0', textAlign: 'center' }}>
            <span style={{ fontSize: '13px', color: '#0369a1', fontWeight: 600 }}>Thời gian hiệu chỉnh nhãn AI</span>
            <div style={{ fontSize: '42px', fontWeight: 'bold', fontFamily: 'monospace', color: '#0284c7', margin: '10px 0' }}>
              {formatDuration(astSec)}
            </div>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
              <button disabled={astRunning} onClick={() => setAstRunning(true)} style={{ background: '#0284c7' }}>Bắt đầu</button>
              <button disabled={!astRunning} onClick={() => setAstRunning(false)} className="secondary">Tạm dừng</button>
              <button onClick={() => { setAstRunning(false); setAstSec(0); }} className="secondary">Đặt lại</button>
            </div>
          </div>

          <label className="drop" style={{ background: 'white', border: '2px dashed #0284c7' }}>
            <span style={{ fontWeight: 600, color: '#0369a1' }}>Tải lên tệp Task_Assisted.zip (Định dạng COCO 1.0 từ CVAT)</span>
            <input
              disabled={loading}
              type="file"
              accept=".zip"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) void handleUploadAssistedZip(f);
                e.target.value = '';
              }}
            />
          </label>

          <div style={{ marginTop: '12px', fontSize: '13px', color: '#64748b' }}>
            Tệp mẫu thử nghiệm nhanh: <code>sample_cvat_assisted.zip</code> trong thư mục <code>Downloads\New folder</code>.
          </div>
        </section>
      )}

      {/* BƯỚC 5: XEM KẾT QUẢ DASHBOARD */}
      {step === 5 && (
        <section className="panel" style={{ textAlign: 'center', padding: '36px 24px' }}>
          <h2 style={{ fontSize: '24px', color: '#0f766e' }}>Hoàn tất thu thập dữ liệu thử nghiệm</h2>
          <p className="muted" style={{ maxWidth: '600px', margin: '10px auto 24px' }}>
            Hệ thống đã ghi nhận đầy đủ dữ liệu từ 3 phương pháp: Gán nhãn thủ công (Manual), Mô hình tự động (AI-Only), và Hiệu chỉnh hỗ trợ (AI-Assisted) cùng thời gian đo lường tương ứng.
          </p>
          <button onClick={onViewResults} style={{ background: '#0f766e', fontSize: '15px', padding: '12px 26px' }}>
            Xem báo cáo phân tích và so sánh nhãn →
          </button>
        </section>
      )}
    </div>
  );
}
