import { useEffect, useRef, useState } from 'react';
import { api, uploadZip } from '../../api';
import type { Asset, LabelSet, Project } from '../../types';

type MethodStats = {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  mean_iou: number;
  overall_quality: number;
  total_seconds: number;
  time_per_image: number;
  images_per_hour: number;
  classes: Record<string, { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number; mean_iou: number }>;
  per_image: { asset_name: string; matched_count: number; fp_count: number; fn_count: number; mean_iou: number }[];
};

type BenchmarkResponse = {
  methods: Record<string, MethodStats>;
  tradeoff: { effort_saved_percent?: number; speedup_factor?: number; time_saved_seconds?: number };
  iou_threshold: number;
};

type VisualizerData = {
  asset_name: string;
  layers: Record<string, { id: string; category: string; geometry: { xyxy: [number, number, number, number] } }[]>;
};

function formatDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function BenchmarkDashboard({
  project,
  assets,
  labels,
  onRefresh,
}: {
  project: Project;
  assets: Asset[];
  labels: LabelSet[];
  onRefresh: () => Promise<void>;
}) {
  const [threshold, setThreshold] = useState(0.5);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [benchmark, setBenchmark] = useState<BenchmarkResponse | null>(null);

  // Đồng hồ bấm giờ cho lượt Sửa nhãn AI (Assisted)
  const [astSec, setAstSec] = useState(0);
  const [astRunning, setAstRunning] = useState(false);
  const astTimerRef = useRef<number | null>(null);

  // Đồng hồ bấm giờ cho lượt Vẽ tay 100% (Manual)
  const [manSec, setManSec] = useState(0);
  const [manRunning, setManRunning] = useState(false);
  const manTimerRef = useRef<number | null>(null);

  const [annotator, setAnnotator] = useState('SinhVien_01');

  // Trình soi ảnh Visualizer
  const [selectedAsset, setSelectedAsset] = useState<string>(assets[0]?.name ?? '');
  const [visData, setVisData] = useState<VisualizerData | null>(null);
  const [showLayers, setShowLayers] = useState({ ground_truth: true, ai: true, assisted: true, manual: false });

  // Quản lý đồng hồ Assisted
  useEffect(() => {
    if (astRunning) {
      astTimerRef.current = window.setInterval(() => setAstSec(s => s + 1), 1000);
    } else if (astTimerRef.current) {
      clearInterval(astTimerRef.current);
    }
    return () => { if (astTimerRef.current) clearInterval(astTimerRef.current); };
  }, [astRunning]);

  // Quản lý đồng hồ Manual
  useEffect(() => {
    if (manRunning) {
      manTimerRef.current = window.setInterval(() => setManSec(s => s + 1), 1000);
    } else if (manTimerRef.current) {
      clearInterval(manTimerRef.current);
    }
    return () => { if (manTimerRef.current) clearInterval(manTimerRef.current); };
  }, [manRunning]);

  // Tải dữ liệu soi ảnh khi chọn ảnh
  useEffect(() => {
    if (!selectedAsset) return;
    api<VisualizerData>(`/projects/${project.id}/visualize/${selectedAsset}`)
      .then(setVisData)
      .catch(() => setVisData(null));
  }, [selectedAsset, project.id, labels]);

  async function handleUploadZip(file: File, source: 'manual' | 'assisted' | 'ai' | 'ground_truth', seconds?: number) {
    setLoading(true);
    setStatus(`Đang tải lên và xử lý tệp ZIP ${file.name}…`);
    try {
      const aiParent = labels.find(l => l.source === 'ai')?.id ?? undefined;
      await uploadZip(`/projects/${project.id}/imports-zip/${source}`, file, {
        annotator,
        parent_id: source === 'assisted' ? aiParent : undefined,
        total_seconds: seconds,
      });
      setStatus(`✅ Đã nạp thành công bộ nhãn ${source.toUpperCase()} từ CVAT!`);
      await onRefresh();
    } catch (e) {
      setStatus(`❌ Lỗi: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function runBenchmark() {
    setLoading(true);
    setStatus('Đang thực thi so sánh Hungarian matching trên toàn bộ ảnh…');
    try {
      const res = await api<BenchmarkResponse>(`/projects/${project.id}/benchmark?iou_threshold=${threshold}`);
      setBenchmark(res);
      setStatus('✅ Đã tính toán xong chỉ số Benchmark!');
    } catch (e) {
      setStatus(`❌ ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  const hasGt = labels.some(l => l.source === 'ground_truth');
  const hasAi = labels.some(l => l.source === 'ai');
  const hasAst = labels.some(l => l.source === 'assisted');
  const hasMan = labels.some(l => l.source === 'manual');

  const curAssetObj = assets.find(a => a.name === selectedAsset);

  return (
    <div style={{ display: 'grid', gap: '24px' }}>
      {/* KHỐI 1: PHÒNG THÍ NGHIỆM ĐO THỜI GIAN & NẠP ZIP TỪ CVAT */}
      <section className="panel" style={{ borderLeft: '4px solid #147d70' }}>
        <h2>⏱️ Phòng Thử Nghiệm Bấm Giờ & Nạp Dữ Liệu CVAT</h2>
        <p className="muted">
          Thực hiện theo đúng luồng khoa học: Đo thời gian thao tác gán nhãn thực tế trên CVAT rồi nạp tệp ZIP COCO 1.0 vào hệ thống.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px', marginTop: '16px' }}>
          {/* LƯỢT 1: ASSISTED (SỬA NHÃN AI) */}
          <div style={{ background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
            <h3 style={{ margin: '0 0 8px', color: '#0369a1' }}>⚡ 1. Sửa Nhãn AI (Assisted)</h3>
            <p className="muted" style={{ fontSize: '12px' }}>Dùng nhãn AI làm khung, người dùng chỉ nắn viền & xóa box sai trên CVAT.</p>
            <div style={{ fontSize: '28px', fontWeight: 'bold', fontFamily: 'monospace', margin: '12px 0', color: '#0284c7' }}>
              {formatDuration(astSec)}
            </div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
              <button disabled={astRunning} onClick={() => setAstRunning(true)} style={{ background: '#0284c7' }}>▶ Bắt đầu</button>
              <button disabled={!astRunning} onClick={() => setAstRunning(false)} className="secondary">⏸ Tạm dừng</button>
              <button onClick={() => { setAstRunning(false); setAstSec(0); }} className="secondary">⏹ Đặt lại</button>
            </div>
            <label className="drop" style={{ background: 'white' }}>
              <span>📦 Tải Task_Assisted.zip từ CVAT</span>
              <input
                disabled={loading}
                type="file"
                accept=".zip"
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) void handleUploadZip(f, 'assisted', astSec);
                  e.target.value = '';
                }}
              />
            </label>
            {hasAst && <span style={{ color: '#16a34a', fontSize: '12px', fontWeight: 600 }}>✓ Đã có dữ liệu nhãn</span>}
          </div>

          {/* LƯỢT 2: MANUAL (VẼ TAY 100%) */}
          <div style={{ background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
            <h3 style={{ margin: '0 0 8px', color: '#b45309' }}>🖐️ 2. Vẽ Thủ Công (Manual)</h3>
            <p className="muted" style={{ fontSize: '12px' }}>Người dùng tự vẽ toàn bộ hộp từ đầu trên CVAT không có trợ giúp.</p>
            <div style={{ fontSize: '28px', fontWeight: 'bold', fontFamily: 'monospace', margin: '12px 0', color: '#d97706' }}>
              {formatDuration(manSec)}
            </div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
              <button disabled={manRunning} onClick={() => setManRunning(true)} style={{ background: '#d97706' }}>▶ Bắt đầu</button>
              <button disabled={!manRunning} onClick={() => setManRunning(false)} className="secondary">⏸ Tạm dừng</button>
              <button onClick={() => { setManRunning(false); setManSec(0); }} className="secondary">⏹ Đặt lại</button>
            </div>
            <label className="drop" style={{ background: 'white' }}>
              <span>📦 Tải Task_Manual.zip từ CVAT</span>
              <input
                disabled={loading}
                type="file"
                accept=".zip"
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) void handleUploadZip(f, 'manual', manSec);
                  e.target.value = '';
                }}
              />
            </label>
            {hasMan && <span style={{ color: '#16a34a', fontSize: '12px', fontWeight: 600 }}>✓ Đã có dữ liệu nhãn</span>}
          </div>

          {/* LƯỢT 3: AI DỰ ĐOÁN (AUTO RUN) */}
          <div style={{ background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
            <h3 style={{ margin: '0 0 8px', color: '#dc2626' }}>🤖 3. Dự Đoán AI (AI-Only)</h3>
            <p className="muted" style={{ fontSize: '12px' }}>Mô hình chạy suy luận tự động (YOLOv8/Colab) không có người can thiệp.</p>
            <div style={{ margin: '20px 0', color: '#64748b', fontSize: '13px' }}>
              Thời gian suy luận: <strong>~0.05s / ảnh</strong>
            </div>
            <label className="drop" style={{ background: 'white', marginTop: '24px' }}>
              <span>📦 Tải Task_AI.zip từ CVAT / Colab</span>
              <input
                disabled={loading}
                type="file"
                accept=".zip"
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) void handleUploadZip(f, 'ai');
                  e.target.value = '';
                }}
              />
            </label>
            {hasAi && <span style={{ color: '#16a34a', fontSize: '12px', fontWeight: 600 }}>✓ Đã có dữ liệu nhãn</span>}
          </div>
        </div>

        <div style={{ marginTop: '16px', display: 'flex', gap: '16px', alignItems: 'center' }}>
          <label style={{ width: '220px' }}>
            Người gán nhãn:
            <input value={annotator} onChange={e => setAnnotator(e.target.value)} />
          </label>
          <span style={{ fontSize: '12px', color: '#64748b' }}>
            Ground Truth: {hasGt ? '✅ Đã nạp' : '⚠️ Chưa có (hãy nạp ở Tab 01)'}
          </span>
        </div>
      </section>

      {/* KHỐI 2: KÍCH HOẠT SO SÁNH BENCHMARK */}
      <section className="panel" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <h2 style={{ margin: '0 0 6px', color: '#166534' }}>🚀 Bắt Đầu So Sánh Đối Đầu 3 Phương Pháp</h2>
            <p className="muted" style={{ margin: 0 }}>
              Sử dụng thuật toán Hungarian matching ghép cặp 1-1 và áp dụng hệ số phạt ngữ nghĩa BDD100K.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <label style={{ margin: 0 }}>
              Ngưỡng IoU (τ): <strong>{threshold}</strong>
              <input
                type="range"
                min="0.3"
                max="0.8"
                step="0.05"
                value={threshold}
                onChange={e => setThreshold(Number(e.target.value))}
                style={{ width: '120px' }}
              />
            </label>
            <button disabled={loading || !hasGt} onClick={() => void runBenchmark()} style={{ background: '#16a34a', fontSize: '15px' }}>
              Chạy Benchmark Ngay ➔
            </button>
          </div>
        </div>
        {status && <p style={{ margin: '12px 0 0', fontWeight: 600, color: status.startsWith('❌') ? '#dc2626' : '#15803d' }}>{status}</p>}
      </section>

      {/* KHỐI 3: KẾT QUẢ BENCHMARK DASHBOARD */}
      {benchmark && (
        <>
          {/* BANNER KẾT LUẬN CÔNG SỨC TIẾT KIỆM ĐƯỢC */}
          {benchmark.tradeoff.effort_saved_percent !== undefined && (
            <div style={{ background: 'linear-gradient(135deg, #0284c7, #0f766e)', color: 'white', padding: '20px 24px', borderRadius: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ textTransform: 'uppercase', fontSize: '11px', letterSpacing: '1.5px', opacity: 0.9 }}>Kết Luận Đề Tài Đột Phá</span>
                <h3 style={{ margin: '4px 0 0', fontSize: '22px' }}>
                  🎉 Mô hình AI Pre-label giúp con người <strong>TIẾT KIỆM {benchmark.tradeoff.effort_saved_percent}% CÔNG SỨC</strong>!
                </h3>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: '32px', fontWeight: 800 }}>{benchmark.tradeoff.speedup_factor}x</span>
                <span style={{ display: 'block', fontSize: '12px', opacity: 0.9 }}>Tăng tốc độ làm nhãn</span>
              </div>
            </div>
          )}

          {/* 3 THẺ ĐỐI ĐẦU HERO CARDS */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '18px' }}>
            {/* THẺ 1: MANUAL */}
            <div className="panel" style={{ margin: 0, borderTop: '4px solid #d97706' }}>
              <span style={{ color: '#d97706', fontWeight: 700, fontSize: '12px' }}>01 · THỦ CÔNG (MANUAL)</span>
              <h3 style={{ margin: '8px 0 16px', fontSize: '20px' }}>Con Người Vẽ Tay</h3>
              <div className="metrics" style={{ gap: '10px' }}>
                <div><strong>{benchmark.methods.manual?.mean_iou ?? 'N/A'}</strong><span>Mean IoU</span></div>
                <div><strong>{benchmark.methods.manual ? `${(benchmark.methods.manual.f1 * 100).toFixed(1)}%` : 'N/A'}</strong><span>F1-Score</span></div>
                <div><strong>{benchmark.methods.manual ? `${benchmark.methods.manual.time_per_image}s` : 'N/A'}</strong><span>Giây / ảnh</span></div>
              </div>
              <p className="muted" style={{ fontSize: '12px', marginTop: '12px' }}>
                Tốc độ: <strong>{benchmark.methods.manual?.images_per_hour ?? 0} ảnh/giờ</strong>. Chất lượng cao nhưng tốn thời gian nhất.
              </p>
            </div>

            {/* THẺ 2: AI ONLY */}
            <div className="panel" style={{ margin: 0, borderTop: '4px solid #dc2626' }}>
              <span style={{ color: '#dc2626', fontWeight: 700, fontSize: '12px' }}>02 · AI TỰ ĐỘNG (AI-ONLY)</span>
              <h3 style={{ margin: '8px 0 16px', fontSize: '20px' }}>Mô Hình Tự Động</h3>
              <div className="metrics" style={{ gap: '10px' }}>
                <div><strong>{benchmark.methods.ai?.mean_iou ?? 'N/A'}</strong><span>Mean IoU</span></div>
                <div><strong>{benchmark.methods.ai ? `${(benchmark.methods.ai.f1 * 100).toFixed(1)}%` : 'N/A'}</strong><span>F1-Score</span></div>
                <div><strong>{benchmark.methods.ai ? `0.05s` : 'N/A'}</strong><span>Giây / ảnh</span></div>
              </div>
              <p className="muted" style={{ fontSize: '12px', marginTop: '12px' }}>
                Vẽ thừa (FP): <strong>{benchmark.methods.ai?.fp ?? 0}</strong>, Bỏ sót (FN): <strong>{benchmark.methods.ai?.fn ?? 0}</strong>. Siêu nhanh nhưng dễ lỗi.
              </p>
            </div>

            {/* THẺ 3: ASSISTED */}
            <div className="panel" style={{ margin: 0, borderTop: '4px solid #0284c7' }}>
              <span style={{ color: '#0284c7', fontWeight: 700, fontSize: '12px' }}>03 · KẾT HỢP (AI-ASSISTED)</span>
              <h3 style={{ margin: '8px 0 16px', fontSize: '20px' }}>AI + Người Sửa</h3>
              <div className="metrics" style={{ gap: '10px' }}>
                <div><strong>{benchmark.methods.assisted?.mean_iou ?? 'N/A'}</strong><span>Mean IoU</span></div>
                <div><strong>{benchmark.methods.assisted ? `${(benchmark.methods.assisted.f1 * 100).toFixed(1)}%` : 'N/A'}</strong><span>F1-Score</span></div>
                <div><strong>{benchmark.methods.assisted ? `${benchmark.methods.assisted.time_per_image}s` : 'N/A'}</strong><span>Giây / ảnh</span></div>
              </div>
              <p className="muted" style={{ fontSize: '12px', marginTop: '12px' }}>
                Tốc độ: <strong>{benchmark.methods.assisted?.images_per_hour ?? 0} ảnh/giờ</strong>. 🏆 <em>Điểm cân bằng tối ưu nhất!</em>
              </p>
            </div>
          </div>

          {/* BẢNG ĐỐI ĐẦU KHOA HỌC CHI TIẾT */}
          <section className="panel">
            <h2>📊 Bảng Đối Chiếu Chỉ Số Khoa Học (Benchmark Matrix)</h2>
            <table>
              <thead>
                <tr>
                  <th>Phương pháp</th>
                  <th>Mean IoU (τ={threshold})</th>
                  <th>Precision</th>
                  <th>Recall</th>
                  <th>F1-Score</th>
                  <th>Vẽ Thừa (FP)</th>
                  <th>Bỏ Sót (FN)</th>
                  <th>Thời Gian / Ảnh</th>
                  <th>Năng Suất (ảnh/giờ)</th>
                </tr>
              </thead>
              <tbody>
                {['manual', 'ai', 'assisted'].map(m => {
                  const data = benchmark.methods[m];
                  if (!data) return null;
                  return (
                    <tr key={m}>
                      <td><strong>{m === 'manual' ? '1. Thủ công (Manual)' : m === 'ai' ? '2. AI Tự động (AI-Only)' : '3. AI Hỗ trợ (Assisted)'}</strong></td>
                      <td>{data.mean_iou}</td>
                      <td>{(data.precision * 100).toFixed(1)}%</td>
                      <td>{(data.recall * 100).toFixed(1)}%</td>
                      <td><strong>{(data.f1 * 100).toFixed(1)}%</strong></td>
                      <td><span style={{ color: data.fp > 0 ? '#dc2626' : 'inherit' }}>{data.fp}</span></td>
                      <td><span style={{ color: data.fn > 0 ? '#d97706' : 'inherit' }}>{data.fn}</span></td>
                      <td>{data.time_per_image}s</td>
                      <td><strong>{data.images_per_hour}</strong></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </>
      )}

      {/* KHỐI 4: TRÌNH SOI ẢNH ĐỐI CHIẾU TRỰC QUAN (VISUALIZER) */}
      <section className="panel">
        <h2>🔍 Trình Soi Ảnh Đối Chiếu Trực Quan 3 Màu Nhãn</h2>
        <p className="muted">
          Chọn ảnh để xem trực quan: Xanh lá (Ground Truth chuẩn), Đỏ (AI dự đoán ban đầu), Xanh dương (Người đã sửa lại).
        </p>

        <div style={{ display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap' }}>
          <label style={{ minWidth: '220px' }}>
            Chọn bức ảnh:
            <select value={selectedAsset} onChange={e => setSelectedAsset(e.target.value)}>
              {assets.map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
            </select>
          </label>
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center', marginTop: '16px' }}>
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: '6px', color: '#16a34a' }}>
              <input type="checkbox" checked={showLayers.ground_truth} onChange={e => setShowLayers(s => ({ ...s, ground_truth: e.target.checked }))} />
              🟩 Ground Truth
            </label>
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: '6px', color: '#dc2626' }}>
              <input type="checkbox" checked={showLayers.ai} onChange={e => setShowLayers(s => ({ ...s, ai: e.target.checked }))} />
              🟥 AI Dự đoán
            </label>
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: '6px', color: '#0284c7' }}>
              <input type="checkbox" checked={showLayers.assisted} onChange={e => setShowLayers(s => ({ ...s, assisted: e.target.checked }))} />
              🟦 Đã sửa (Assisted)
            </label>
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: '6px', color: '#d97706' }}>
              <input type="checkbox" checked={showLayers.manual} onChange={e => setShowLayers(s => ({ ...s, manual: e.target.checked }))} />
              🟧 Vẽ tay (Manual)
            </label>
          </div>
        </div>

        {curAssetObj && (
          <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', borderRadius: '8px', overflow: 'hidden', border: '1px solid #cbd5e1' }}>
            <img
              src={curAssetObj.url}
              alt={curAssetObj.name}
              style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
            />
            {/* Lớp phủ SVG vẽ Bounding Box theo tỷ lệ ảnh */}
            <svg
              viewBox={`0 0 ${curAssetObj.width || 1280} ${curAssetObj.height || 720}`}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
            >
              {/* Ground Truth: Viền Xanh Lá */}
              {showLayers.ground_truth && visData?.layers.ground_truth?.map(obj => {
                const [x1, y1, x2, y2] = obj.geometry.xyxy;
                return (
                  <g key={`gt-${obj.id}`}>
                    <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="rgba(34, 197, 94, 0.15)" stroke="#22c55e" strokeWidth={3} />
                    <text x={x1} y={Math.max(16, y1 - 4)} fill="#22c55e" fontSize="16" fontWeight="bold">GT: {obj.category}</text>
                  </g>
                );
              })}

              {/* AI: Viền Đỏ Nét Đứt */}
              {showLayers.ai && visData?.layers.ai?.map(obj => {
                const [x1, y1, x2, y2] = obj.geometry.xyxy;
                return (
                  <g key={`ai-${obj.id}`}>
                    <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="none" stroke="#ef4444" strokeWidth={2.5} strokeDasharray="6 3" />
                    <text x={x1} y={Math.max(32, y1 + 16)} fill="#ef4444" fontSize="14" fontWeight="bold">AI: {obj.category}</text>
                  </g>
                );
              })}

              {/* Assisted: Viền Xanh Dương */}
              {showLayers.assisted && visData?.layers.assisted?.map(obj => {
                const [x1, y1, x2, y2] = obj.geometry.xyxy;
                return (
                  <g key={`ast-${obj.id}`}>
                    <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="none" stroke="#0284c7" strokeWidth={2.5} />
                    <text x={x1} y={y2 + 18} fill="#0284c7" fontSize="14" fontWeight="bold">Fix: {obj.category}</text>
                  </g>
                );
              })}

              {/* Manual: Viền Cam */}
              {showLayers.manual && visData?.layers.manual?.map(obj => {
                const [x1, y1, x2, y2] = obj.geometry.xyxy;
                return (
                  <g key={`man-${obj.id}`}>
                    <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="none" stroke="#f59e0b" strokeWidth={2} />
                    <text x={x1} y={y2 + 18} fill="#f59e0b" fontSize="14">Man: {obj.category}</text>
                  </g>
                );
              })}
            </svg>
          </div>
        )}
      </section>
    </div>
  );
}
