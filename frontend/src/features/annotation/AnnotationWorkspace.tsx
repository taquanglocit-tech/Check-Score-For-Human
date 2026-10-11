import { useEffect, useRef, useState } from 'react';
import { api, postJSON } from '../../api';
import type { Asset, LabelSet, Project } from '../../types';

type BoxObject = {
  id: string;
  category: string;
  geometry: {
    kind: 'bbox2d';
    xyxy: [number, number, number, number];
  };
  confidence?: number | null;
};

export default function AnnotationWorkspace({
  project,
  assets,
  labels,
  onSaved,
}: {
  project: Project;
  assets: Asset[];
  labels: LabelSet[];
  onSaved: () => Promise<void>;
}) {
  const eligible = assets.filter(a => project.task === 'detection_3d' ? a.kind === 'pointcloud' : a.kind === 'image');
  const [assetId, setAssetId] = useState('');
  const asset = eligible.find(a => a.id === assetId) ?? eligible[0];

  const [mode, setMode] = useState<'manual' | 'assisted'>('manual');
  const [parentId, setParentId] = useState('');
  const [annotator, setAnnotator] = useState('SinhVien_01');
  const [selectedClass, setSelectedClass] = useState(project.classes[0] || 'car');
  const [boxList, setBoxList] = useState<BoxObject[]>([]);

  // Đồng hồ tính giờ gán nhãn
  const [seconds, setSeconds] = useState(0);
  const [timerActive, setTimerActive] = useState(false);

  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // Tham chiếu vẽ chuột
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [drawing, setDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
  const [currentPoint, setCurrentPoint] = useState<{ x: number; y: number } | null>(null);

  // Quản lý đồng hồ
  useEffect(() => {
    let interval: number | null = null;
    if (timerActive) {
      interval = window.setInterval(() => setSeconds(s => s + 1), 1000);
    }
    return () => { if (interval) clearInterval(interval); };
  }, [timerActive]);

  // Khi đổi ảnh hoặc đổi chế độ: reset nhãn
  useEffect(() => {
    setBoxList([]);
    setSeconds(0);
    setTimerActive(false);
    setStatus('');
    setDrawing(false);
    setStartPoint(null);
    setCurrentPoint(null);
  }, [asset?.id, mode]);

  // Nạp nhãn AI khi chọn chế độ Assisted
  async function loadAI(id: string) {
    setParentId(id);
    setBoxList([]);
    setStatus('');
    if (!id || !asset) return;
    setBusy(true);
    try {
      const data = await api<{ samples: { asset_name: string; objects: BoxObject[] }[] }>(`/label-sets/${id}`);
      const sample = data.samples.find(s => s.asset_name === asset.name);
      if (!sample) throw new Error(`Lần chạy AI không có nhãn cho ảnh "${asset.name}".`);
      setBoxList(sample.objects || []);
      setStatus(`✅ Đã nạp ${sample.objects.length} hộp do AI dự đoán lên ảnh! Bạn có thể nắn viền, xóa hoặc vẽ thêm.`);
    } catch (e) {
      setStatus(`❌ ${String(e)}`);
      setParentId('');
    } finally {
      setBusy(false);
    }
  }

  // Tọa độ thực tế từ sự kiện chuột
  function getImgCoords(e: React.MouseEvent) {
    if (!imgRef.current) return null;
    const rect = imgRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const natW = asset?.width || imgRef.current.naturalWidth || 1280;
    const natH = asset?.height || imgRef.current.naturalHeight || 720;

    const scaleX = natW / rect.width;
    const scaleY = natH / rect.height;

    const realX = Math.round(Math.max(0, Math.min(natW, clickX * scaleX)));
    const realY = Math.round(Math.max(0, Math.min(natH, clickY * scaleY)));

    return { x: realX, y: realY };
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0 || !asset) return;
    const coords = getImgCoords(e);
    if (!coords) return;
    setDrawing(true);
    setStartPoint(coords);
    setCurrentPoint(coords);
    if (!timerActive) setTimerActive(true); // Tự động bật giờ khi bắt đầu vẽ
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!drawing || !startPoint) return;
    const coords = getImgCoords(e);
    if (coords) setCurrentPoint(coords);
  }

  function handleMouseUp() {
    if (!drawing || !startPoint || !currentPoint) {
      setDrawing(false);
      return;
    }
    const x1 = Math.min(startPoint.x, currentPoint.x);
    const y1 = Math.min(startPoint.y, currentPoint.y);
    const x2 = Math.max(startPoint.x, currentPoint.x);
    const y2 = Math.max(startPoint.y, currentPoint.y);

    // Bỏ qua nếu kéo quá nhỏ (vô tình click)
    if (x2 - x1 >= 10 && y2 - y1 >= 10) {
      const newBox: BoxObject = {
        id: `box-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        category: selectedClass,
        geometry: {
          kind: 'bbox2d',
          xyxy: [x1, y1, x2, y2],
        },
        confidence: null,
      };
      setBoxList(prev => [...prev, newBox]);
    }

    setDrawing(false);
    setStartPoint(null);
    setCurrentPoint(null);
  }

  function deleteBox(id: string) {
    setBoxList(prev => prev.filter(b => b.id !== id));
  }

  async function save() {
    if (!asset) return;
    setBusy(true);
    setStatus('');
    try {
      await postJSON(`/projects/${project.id}/annotations/${mode}`, {
        schema_version: '1.0',
        task: project.task,
        name: `${mode.toUpperCase()} · ${asset.name}`,
        annotator: annotator.trim() || 'Người gán nhãn',
        parent_id: mode === 'assisted' ? parentId : null,
        samples: [{
          asset_name: asset.name,
          objects: boxList,
          active_seconds: seconds > 0 ? seconds : null,
        }],
      });
      setTimerActive(false);
      setStatus(`🎉 Đã lưu thành công phiên bản nhãn ${mode.toUpperCase()} cho ảnh "${asset.name}"!`);
      await onSaved();
    } catch (e) {
      setStatus(`❌ Lỗi: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const aiLabels = labels.filter(l => l.source === 'ai');
  const natW = asset?.width || 1280;
  const natH = asset?.height || 720;

  return (
    <section className="panel" style={{ borderLeft: '4px solid #0f766e' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ margin: 0, color: '#0f766e' }}>✏️ Không Gian Gán Nhãn Trực Quan (Kéo Chuột Vẽ Hộp)</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Dùng chuột kéo thả để vẽ bounding box trực tiếp trên ảnh. Không cần gõ JSON thủ công!
          </p>
        </div>
        {/* ĐỒNG HỒ TÍNH GIỜ */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#f1f5f9', padding: '6px 14px', borderRadius: '8px', border: '1px solid #cbd5e1' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>⏱️ Thời gian:</span>
          <span style={{ fontSize: '20px', fontWeight: 'bold', fontFamily: 'monospace', color: timerActive ? '#16a34a' : '#0f172a' }}>
            {Math.floor(seconds / 60).toString().padStart(2, '0')}:{(seconds % 60).toString().padStart(2, '0')}
          </span>
          <button
            onClick={() => setTimerActive(a => !a)}
            style={{ padding: '4px 10px', fontSize: '12px', background: timerActive ? '#dc2626' : '#16a34a' }}
          >
            {timerActive ? 'Tạm dừng' : 'Bắt đầu'}
          </button>
        </div>
      </div>

      {!asset ? (
        <p style={{ marginTop: '20px' }}>Chưa có ảnh nào. Vui lòng tải ảnh lên ở Tab 01 trước.</p>
      ) : (
        <>
          {/* KHỐI CẤU HÌNH GÁN NHÃN */}
          <div className="fields" style={{ marginTop: '16px', background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
            <label>
              01 · Chọn bức ảnh:
              <select disabled={busy} value={asset.id} onChange={e => setAssetId(e.target.value)}>
                {eligible.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>

            <label>
              02 · Chế độ gán nhãn:
              <select disabled={busy} value={mode} onChange={e => setMode(e.target.value as 'manual' | 'assisted')}>
                <option value="manual">🖐️ Người tự vẽ từ đầu (Manual)</option>
                <option value="assisted">⚡ Người sửa từ gợi ý AI (Assisted)</option>
              </select>
            </label>

            <label>
              03 · Tên người gán:
              <input value={annotator} onChange={e => setAnnotator(e.target.value)} placeholder="SinhVien_01" />
            </label>

            {mode === 'assisted' && (
              <label style={{ minWidth: '240px' }}>
                04 · Lần chạy AI muốn nạp:
                <select disabled={busy} value={parentId} onChange={e => void loadAI(e.target.value)}>
                  <option value="">-- Chọn để nạp nhãn AI lên ảnh --</option>
                  {aiLabels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </label>
            )}
          </div>

          {/* CHỌN LỚP ĐỐI TƯỢNG ĐỂ VẼ */}
          <div style={{ margin: '14px 0', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '13px', fontWeight: 700, color: '#334155' }}>Chọn lớp vẽ:</span>
            {project.classes.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setSelectedClass(c)}
                style={{
                  padding: '6px 14px',
                  fontSize: '12px',
                  borderRadius: '20px',
                  background: selectedClass === c ? '#0f766e' : '#e2e8f0',
                  color: selectedClass === c ? '#ffffff' : '#334155',
                  border: 'none',
                  cursor: 'pointer',
                  fontWeight: selectedClass === c ? 700 : 500,
                }}
              >
                {c}
              </button>
            ))}
          </div>

          {/* VÙNG LÀM VIỆC CHÍNH: ẢNH VẼ BẰNG CHUỘT + DANH SÁCH HỘP */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)', gap: '20px', marginTop: '16px' }}>
            {/* CỘT TRÁI: ẢNH VỚI KHẢ NĂNG KÉO THẢ VẼ CHUỘT */}
            <div
              ref={containerRef}
              style={{
                position: 'relative',
                display: 'inline-block',
                background: '#0f172a',
                borderRadius: '8px',
                overflow: 'hidden',
                userSelect: 'none',
                cursor: 'crosshair',
                border: '2px solid #cbd5e1',
              }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
            >
              <img
                ref={imgRef}
                src={asset.url}
                alt={asset.name}
                draggable={false}
                style={{ display: 'block', width: '100%', height: 'auto', pointerEvents: 'none' }}
              />

              {/* LỚP SVG HIỂN THỊ CÁC HỘP ĐÃ VẼ */}
              <svg
                viewBox={`0 0 ${natW} ${natH}`}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
              >
                {boxList.map((box, idx) => {
                  const [x1, y1, x2, y2] = box.geometry.xyxy;
                  const isAiPre = box.id.startsWith('ai-');
                  const strokeColor = isAiPre ? '#ef4444' : mode === 'assisted' ? '#0284c7' : '#d97706';
                  return (
                    <g key={box.id}>
                      <rect
                        x={x1}
                        y={y1}
                        width={x2 - x1}
                        height={y2 - y1}
                        fill="rgba(15, 118, 110, 0.15)"
                        stroke={strokeColor}
                        strokeWidth={2.5}
                        strokeDasharray={isAiPre ? '6 3' : undefined}
                      />
                      <rect
                        x={x1}
                        y={Math.max(0, y1 - 22)}
                        width={Math.max(60, box.category.length * 10 + 20)}
                        height={22}
                        fill={strokeColor}
                      />
                      <text
                        x={x1 + 6}
                        y={Math.max(16, y1 - 6)}
                        fill="#ffffff"
                        fontSize="14"
                        fontWeight="bold"
                      >
                        #{idx + 1} {box.category}
                      </text>
                    </g>
                  );
                })}

                {/* HỘP ĐANG KÉO CHUỘT (PREVIEW) */}
                {drawing && startPoint && currentPoint && (
                  <rect
                    x={Math.min(startPoint.x, currentPoint.x)}
                    y={Math.min(startPoint.y, currentPoint.y)}
                    width={Math.abs(currentPoint.x - startPoint.x)}
                    height={Math.abs(currentPoint.y - startPoint.y)}
                    fill="rgba(14, 165, 233, 0.2)"
                    stroke="#0284c7"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                  />
                )}
              </svg>
            </div>

            {/* CỘT PHẢI: DANH SÁCH CÁC HỘP ĐÃ VẼ + NÚT XÓA */}
            <div style={{ background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <h3 style={{ margin: 0, fontSize: '15px', color: '#1e293b' }}>
                  Danh sách hộp ({boxList.length})
                </h3>
                {boxList.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setBoxList([])}
                    style={{ background: '#ef4444', padding: '4px 8px', fontSize: '11px' }}
                  >
                    Xóa tất cả
                  </button>
                )}
              </div>

              <div style={{ flex: 1, maxHeight: '380px', overflowY: 'auto', display: 'grid', gap: '8px' }}>
                {boxList.length === 0 ? (
                  <p className="muted" style={{ fontSize: '13px', textAlign: 'center', marginTop: '40px' }}>
                    Chưa có hộp nào.<br />
                    👉 <em>Hãy giữ chuột trái và kéo trên ảnh để vẽ hộp đầu tiên!</em>
                  </p>
                ) : (
                  boxList.map((box, idx) => (
                    <div
                      key={box.id}
                      style={{
                        background: 'white',
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid #cbd5e1',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <div>
                        <strong>#{idx + 1} {box.category}</strong>
                        <div style={{ fontSize: '11px', color: '#64748b' }}>
                          [{box.geometry.xyxy[0]}, {box.geometry.xyxy[1]}, {box.geometry.xyxy[2]}, {box.geometry.xyxy[3]}]
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => deleteBox(box.id)}
                        style={{ background: '#fee2e2', color: '#dc2626', padding: '4px 8px', fontSize: '11px' }}
                      >
                        ✕ Xóa
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* NÚT LƯU KẾT QUẢ */}
              <div style={{ marginTop: '16px', borderTop: '1px solid #e2e8f0', paddingTop: '12px' }}>
                <button
                  disabled={busy || (mode === 'assisted' && !parentId) || boxList.length === 0}
                  onClick={() => void save()}
                  style={{ width: '100%', background: '#0f766e', fontSize: '15px' }}
                >
                  💾 Lưu Phiên Bản Nhãn {mode.toUpperCase()}
                </button>
                {status && (
                  <p style={{ margin: '8px 0 0', fontSize: '12px', fontWeight: 600, color: status.startsWith('❌') ? '#dc2626' : '#15803d' }}>
                    {status}
                  </p>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
