import { useCallback, useEffect, useState } from 'react';
import { api, postJSON, upload } from './api';
import type { Asset, LabelSet, Project, Task } from './types';
import { taskNames } from './types';
import AnnotationWorkspace from './features/annotation/AnnotationWorkspace';
import BenchmarkDashboard from './features/benchmark/BenchmarkDashboard';
import BenchmarkWizard from './features/benchmark/BenchmarkWizard';

type Summary = { assets: number; label_sets: Record<string, number>; evaluation_status: string };
export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [task, setTask] = useState<Task>('detection_2d');
  const [classes, setClasses] = useState('car, bus, truck, pedestrian');
  const [tab, setTab] = useState('wizard');
  const [assets, setAssets] = useState<Asset[]>([]);

  const [labels, setLabels] = useState<LabelSet[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const project = projects.find(p => p.id === selected);
  const refresh = useCallback(async () => {
    if (!selected) return;
    const [a, l, s] = await Promise.all([api<Asset[]>(`/projects/${selected}/assets`), api<LabelSet[]>(`/projects/${selected}/label-sets`), api<Summary>(`/projects/${selected}/summary`)]);
    setAssets(a); setLabels(l); setSummary(s);
  }, [selected]);
  useEffect(() => {api<Project[]>('/projects').then(setProjects).catch(e => setStatus(String(e)));}, []);
  useEffect(() => {setAssets([]); setLabels([]); setSummary(null); void refresh().catch(e => setStatus(String(e)));}, [refresh]);
  async function create() {
    setBusy(true);
    try {
      const p = await postJSON<Project>('/projects', {name, task, classes: classes.split(',').map(c => c.trim()).filter(Boolean)});
      setProjects(await api<Project[]>('/projects')); setSelected(p.id); setName(''); setStatus('Đã tạo dự án.');
    } catch(e) { setStatus(String(e)); } finally { setBusy(false); }
  }
  async function uploadFiles(files: FileList | null, type: string) {
    if (!files || !project) return;
    setBusy(true); let done = 0;
    try {
      for (const file of Array.from(files)) {
        setStatus(`Đang tải ${file.name} (${done + 1}/${files.length})…`);
        await upload(`/projects/${project.id}/${type === 'assets' ? 'assets' : `imports/${type}`}`, file); done++;
      }
      setStatus(`Đã nhập ${done} tệp.`);
    } catch(e) { setStatus(`Đã nhập ${done} tệp. ${String(e)}`); }
    finally { await refresh().catch(e => setStatus(String(e))); setBusy(false); }
  }
  return <div className="layout">
    <aside><div className="brand">M49<span>ANNOTATION BENCHMARK</span></div><p className="muted">Local workspace · v0.1 scaffold</p>
      <label>Dự án<select disabled={busy} value={selected} onChange={e => setSelected(e.target.value)}><option value="">Chọn dự án</option>{projects.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
      <nav>{[
        ['wizard','Quy trình thử nghiệm'],
        ['data','Kho dữ liệu mẫu'],
        ['annotate','Gán nhãn tương tác'],
        ['results','Báo cáo đánh giá']
      ].map(([id,title]) => <button className={tab === id ? 'active' : ''} onClick={() => setTab(id)} key={id}>{title}</button>)}</nav>
      <p className="muted">AI chạy trên Colab.<br/>Nhập kết quả để lưu và xử lý trên máy.</p>
      <a href="http://localhost:8000/docs" target="_blank" rel="noreferrer">API documentation ↗</a>
    </aside>
    <main><header><div className="eyebrow">HUMAN × AI BENCHMARK WIZARD</div><h1>{project?.name ?? 'Không gian thử nghiệm gán nhãn'}</h1><p className="muted">{project ? taskNames[project.task] : 'Chọn hoặc tạo đợt thử nghiệm để bắt đầu quy trình đối chiếu 3 phương pháp.'}</p></header>
      <p className="status" role="status">{status}</p>

      {tab === 'wizard' && (
        <BenchmarkWizard
          project={project}
          assets={assets}
          labels={labels}
          onProjectCreated={async (newId) => {
            const pList = await api<Project[]>('/projects');
            setProjects(pList);
            setSelected(newId);
          }}
          onRefresh={refresh}
          onViewResults={() => setTab('results')}
        />
      )}

      {tab === 'data' && (
        <>
          <details className="panel" open={!project}><summary>Tạo dự án thủ công</summary><div className="fields">
            <label>Tên dự án<input value={name} onChange={e => setName(e.target.value)} placeholder="BDD100K · thử nghiệm 01"/></label>
            <label>Tác vụ<select value={task} onChange={e => setTask(e.target.value as Task)}>{Object.entries(taskNames).map(([id,title]) => <option key={id} value={id}>{title}</option>)}</select></label>
            <label>Các lớp, cách nhau bằng dấu phẩy<input value={classes} onChange={e => setClasses(e.target.value)}/></label>
            <button disabled={busy || !name.trim()} onClick={() => void create()}>Tạo dự án</button>
          </div></details>
          {project && <>
            <section className="panel"><h2>Nhập dữ liệu thủ công</h2><p className="muted">Upload ảnh trước, sau đó nhập nhãn theo schema M49 hoặc BDD100K. Tối đa 256 MiB/tệp.</p><div className="upload-grid">
              <label className="drop">01 · Ảnh / point cloud<input disabled={busy} type="file" multiple accept={project.task === 'detection_3d' ? '.jpg,.jpeg,.png,.bin,.pcd' : '.jpg,.jpeg,.png'} onChange={e => {void uploadFiles(e.target.files, 'assets'); e.target.value = '';}}/></label>
              <label className="drop">02 · Ground truth JSON<input disabled={busy} type="file" accept=".json" onChange={e => {void uploadFiles(e.target.files, 'ground_truth'); e.target.value = '';}}/></label>
              <label className="drop">03 · Kết quả AI JSON<input disabled={busy} type="file" accept=".json" onChange={e => {void uploadFiles(e.target.files, 'ai'); e.target.value = '';}}/></label>
            </div></section>
            <section className="panel"><h2>Dữ liệu đã lưu · {assets.length}</h2><div className="gallery">{assets.map(a => <article key={a.id}>{a.kind === 'image' ? <img loading="lazy" src={a.url} alt={a.name}/> : <div className="cloud">POINT CLOUD</div>}<strong>{a.name}</strong><small>{a.width ? `${a.width} × ${a.height}` : a.kind}</small></article>)}</div>{!assets.length && <p className="muted">Chưa có dữ liệu.</p>}</section>
          </>}
        </>
      )}

      {project && tab === 'annotate' && <AnnotationWorkspace key={project.id} project={project} assets={assets} labels={labels} onSaved={refresh}/>}
      {project && tab === 'results' && <BenchmarkDashboard key={project.id} project={project} assets={assets} labels={labels} onRefresh={refresh} />}

    </main>
  </div>;
}
