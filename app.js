// ============================================================
// JURNAL GURU DIGITAL v3 — app.js
// Multi-guru, Semester, TP→Nilai, Profil Siswa,
// Kalender, Analitik, Notifikasi
// ============================================================

const SUPABASE_URL = 'https://zpvfkaxqejlkzcsjgkjq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_kQ_TJUz3g5N2qL-4tUwSMQ_-CEjxjp7';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================================
// STATE
// ============================================================
let currentTeacher = null; // {id, username, nama, mapel, is_admin}
let settings = { semester_aktif:'Ganjil', tahun_ajaran_aktif:'2026/2027', kkm:75 };

let students=[], teachers=[];
let journalEntries=[], attendanceRecords=[], participations=[];
let incidents=[], gradeTypes=[], grades=[], learningObjectives=[];

// ============================================================
// UTILS
// ============================================================
function esc(s){ if(s==null)return''; return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtDate(d){ if(!d)return'-'; return new Date(d+'T00:00:00').toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'}); }
function fmtDateShort(d){ if(!d)return'-'; return new Date(d+'T00:00:00').toLocaleDateString('id-ID',{day:'2-digit',month:'short'}); }
function today(){ return new Date().toISOString().slice(0,10); }
async function sha256(msg){ const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(msg)); return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join(''); }
function studentsByClass(k){ return students.filter(s=>s.kelas===k); }
function studentName(id){ const s=students.find(x=>x.id===id); return s?s.nama:'(?)'; }
function studentObj(id){ return students.find(x=>x.id===id)||null; }
function tpLabel(id,short=false){ const t=learningObjectives.find(x=>x.id===id); if(!t)return'-'; return short?t.nomor_tp:`${t.nomor_tp} — ${t.deskripsi.slice(0,60)}${t.deskripsi.length>60?'…':''}`; }
function getNamaPenilaianList(kelas,gtId){ return [...new Set(grades.filter(g=>g.grade_type_id===gtId&&studentsByClass(kelas).some(s=>s.id===g.student_id)).map(g=>g.nama_penilaian))].sort(); }
function myFilter(arr){ return arr.filter(r=>r.teacher_id===currentTeacher.id||r.teacher_id===null); }
function periodFilter(arr){ return myFilter(arr).filter(r=>(!r.semester||r.semester===settings.semester_aktif)&&(!r.tahun_ajaran||r.tahun_ajaran===settings.tahun_ajaran_aktif)); }

// ============================================================
// TOAST & SYNC
// ============================================================
function showToast(msg,type='success'){
  const t=document.getElementById('toast');
  t.textContent=msg; t.className='toast show '+type;
  setTimeout(()=>t.className='toast',2600);
}
function setSync(state,text){
  const dot=document.getElementById('syncDot');
  const txt=document.getElementById('syncText');
  if(!dot)return;
  dot.className='dot'+(state==='busy'?' busy':state==='err'?' err':'');
  txt.textContent=text;
}

// ============================================================
// THEME
// ============================================================
function initTheme(){ applyTheme(localStorage.getItem('jg_theme')||'light'); }
function applyTheme(t){
  document.documentElement.setAttribute('data-theme',t);
  const btn=document.getElementById('themeBtn');
  if(btn) btn.textContent=t==='dark'?'🌙':'☀️';
  localStorage.setItem('jg_theme',t);
}
function toggleTheme(){ applyTheme(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark'); }

// ============================================================
// AUTH
// ============================================================
async function doLogin(){
  const uname=document.getElementById('loginUsername').value.trim();
  const pw=document.getElementById('loginPassword').value;
  const errEl=document.getElementById('loginError');
  errEl.textContent='';
  if(!uname||!pw){ errEl.textContent='Username dan password wajib diisi.'; return; }
  setSync('busy','Login...');
  try{
    const hash=await sha256(pw);
    // Cek apakah ini first login (password_hash = CHANGE_ON_FIRST_LOGIN)
    const {data:teacher,error}=await sb.from('teachers').select('*').eq('username',uname).eq('aktif',true).single();
    if(error||!teacher){ setSync('err',''); document.getElementById('loginError').textContent='Username tidak ditemukan.'; return; }
    if(teacher.password_hash==='CHANGE_ON_FIRST_LOGIN'){
      // First login — set password sekarang
      const {error:upErr}=await sb.from('teachers').update({password_hash:hash}).eq('id',teacher.id);
      if(upErr) throw upErr;
      teacher.password_hash=hash;
    }
    if(teacher.password_hash!==hash){ setSync('err',''); document.getElementById('loginError').textContent='Password salah.'; return; }
    currentTeacher=teacher;
    sessionStorage.setItem('jg_teacher', JSON.stringify(teacher));
    await bootApp();
  } catch(err){ setSync('err',''); document.getElementById('loginError').textContent='Error: '+err.message; }
}

function doLogout(){ sessionStorage.removeItem('jg_teacher'); location.reload(); }

async function bootApp(){
  document.getElementById('loginScreen').style.display='none';
  document.getElementById('app').style.display='block';
  document.getElementById('teacherName').textContent=currentTeacher.nama;
  document.getElementById('teacherMapel').textContent=currentTeacher.mapel;
  if(!currentTeacher.is_admin) document.querySelectorAll('.admin-only').forEach(el=>el.style.display='none');
  await loadSettings();
  await loadAll();
  // Backfill teacher_id untuk data lama (teacher_id=null)
  await backfillTeacherId();
  // Init kelas list dari students + default
  const fromStudents=[...new Set(students.map(s=>s.kelas).filter(Boolean))];
  const stored=JSON.parse(localStorage.getItem('jg_kelas_list')||'[]');
  const merged=[...new Set([...stored,...fromStudents])].sort();
  if(!stored.length&&fromStudents.length) saveKelasList(merged);
  // Jika belum ada sama sekali, set default
  if(!merged.length) saveKelasList(['9A','9B','9C']);
  updateAllKelasDropdowns();
  updatePeriodBadge();
  renderDashboard();
}

async function backfillTeacherId(){
  // Hanya admin yang melakukan backfill data lama
  if(!currentTeacher.is_admin) return;
  const tables=['journal_entries','attendance','participation','incidents','grades','grade_types','learning_objectives','students'];
  for(const t of tables){
    await sb.from(t).update({teacher_id:currentTeacher.id}).is('teacher_id',null);
  }
  // Reload setelah backfill
  await loadAll();
}

// ============================================================
// SETTINGS & PERIODE
// ============================================================
async function loadSettings(){
  const {data}=await sb.from('app_settings').select('*').eq('teacher_id',currentTeacher.id).maybeSingle();
  if(data){ settings=data; }
  else {
    // Create default settings
    const {data:created}=await sb.from('app_settings').insert({teacher_id:currentTeacher.id,...settings}).select().single();
    if(created) settings=created;
  }
}
async function saveSettings(){
  const s=settings.semester_aktif;
  const ta=settings.tahun_ajaran_aktif;
  const kkm=settings.kkm;
  await sb.from('app_settings').upsert({teacher_id:currentTeacher.id,semester_aktif:s,tahun_ajaran_aktif:ta,kkm}).eq('teacher_id',currentTeacher.id);
}
function updatePeriodBadge(){
  const el=document.getElementById('periodBadge');
  if(el) el.textContent=`${settings.semester_aktif} ${settings.tahun_ajaran_aktif}`;
  ['settingSemester','settingTA','settingKKM'].forEach(id=>{
    const el=document.getElementById(id);
    if(!el)return;
    if(id==='settingSemester') el.value=settings.semester_aktif;
    if(id==='settingTA') el.value=settings.tahun_ajaran_aktif;
    if(id==='settingKKM') el.value=settings.kkm;
  });
}

// ============================================================
// LOAD ALL DATA
// ============================================================
async function loadAll(){
  setSync('busy','Memuat data...');
  try{
    const [s,j,a,inc,gt,g,p,lo,tr]=await Promise.all([
      sb.from('students').select('*').order('kelas').order('no_urut'),
      sb.from('journal_entries').select('*').order('tanggal',{ascending:false}),
      sb.from('attendance').select('*'),
      sb.from('incidents').select('*').order('tanggal',{ascending:false}),
      sb.from('grade_types').select('*'),
      sb.from('grades').select('*'),
      sb.from('participation').select('*'),
      sb.from('learning_objectives').select('*').eq('aktif',true).order('urutan').order('nomor_tp'),
      sb.from('teachers').select('id,username,nama,mapel,is_admin,aktif')
    ]);
    students=s.data||[];
    journalEntries=j.data||[];
    attendanceRecords=a.data||[];
    incidents=inc.data||[];
    gradeTypes=gt.data||[];
    grades=g.data||[];
    participations=p.data||[];
    learningObjectives=lo.data||[];
    teachers=tr.data||[];
    setSync('','Tersinkron');
  } catch(err){
    console.error(err); setSync('err','Gagal'); showToast('Gagal memuat: '+err.message,'error');
  }
}

// ============================================================
// TAB SWITCHING
// ============================================================
function switchTab(tab){
  // Update sidebar nav active state
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
  const btn=document.querySelector(`.nav-item[data-tab="${tab}"]`);
  if(btn) btn.classList.add('active');
  // Show/hide tab content via CSS class
  document.querySelectorAll('.tab-content').forEach(s=>s.classList.remove('active'));
  const sec=document.getElementById('tab-'+tab);
  if(sec) sec.classList.add('active');

  const dispatch={
    dashboard: renderDashboard,
    pertemuan: ()=>{ initPertemuanForm(); renderJournalList(); },
    keaktifan: ()=>{ loadParticipationForm(); renderParticipationRecap(); },
    kejadian:  ()=>{ populateStudentSelect('iSiswa'); populateIncidentStudentFilter(); renderIncidentList(); },
    nilai:     ()=>{ loadGradeForm(); renderWeightSettings(); renderFinalGrades(); },
    kalender:  renderKalender,
    profil:    renderProfilList,
    tp:        ()=>{ renderTPList(); },
    siswa:     ()=>{ renderSiswaTab(); },
    pengaturan:()=>{ renderPengaturanTab(); },
  };
  if(dispatch[tab]) dispatch[tab]();
}

// ============================================================
// DASHBOARD
// ============================================================
function renderDashboard(){
  const j=periodFilter(journalEntries);
  const a=periodFilter(attendanceRecords);
  const p=periodFilter(participations);
  const inc=periodFilter(incidents);
  const g=periodFilter(grades);

  // Stat cards — modern icon style
  const pct=a.length?Math.round(a.filter(x=>x.status==='Hadir').length/a.length*100):0;
  const oi=myFilter(incidents).filter(i=>i.status==='Open').length;
  document.getElementById('dashStats').innerHTML=`
    <div class="stat-card"><div class="stat-icon blue">📝</div><div><div class="stat-num">${j.length}</div><div class="stat-lbl">Pertemuan Semester Ini</div></div></div>
    <div class="stat-card"><div class="stat-icon green">✅</div><div><div class="stat-num">${pct}%</div><div class="stat-lbl">Rata-rata Kehadiran</div></div></div>
    <div class="stat-card"><div class="stat-icon purple">🏅</div><div><div class="stat-num">${g.length}</div><div class="stat-lbl">Entri Nilai</div></div></div>
    <div class="stat-card"><div class="stat-icon ${oi>0?'red':'green'}">${oi>0?'⚠️':'🎉'}</div><div><div class="stat-num" style="color:${oi>0?'var(--bad)':'var(--good)'}">${oi}</div><div class="stat-lbl">Kejadian Terbuka</div></div></div>`;

  // Notifikasi / Flag
  const flags=buildFlags(a,g,p);
  const flagEl=document.getElementById('dashFlags');
  if(flags.length){
    flagEl.innerHTML=flags.map(f=>`<div class="flag flag-${f.level}">
      <span class="flag-icon">${f.level==='warn'?'⚠️':'🔴'}</span>
      <span>${esc(f.msg)}</span>
    </div>`).join('');
  } else {
    flagEl.innerHTML='<div class="empty" style="padding:12px;">Tidak ada notifikasi — semua aman! ✅</div>';
  }

  // Per kelas: perhatian khusus + paling aktif
  const kelasCards=document.getElementById('dashKelasCards');
  kelasCards.innerHTML=getKelasList().map(kelas=>buildKelasCard(kelas,a,p)).join('');

  // Jurnal terbaru
  const recent=periodFilter(journalEntries).slice(0,5);
  document.getElementById('dashRecent').innerHTML=recent.length
    ?`<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Kelas</th><th>Materi</th></tr></thead><tbody>
       ${recent.map(j=>`<tr><td>${fmtDate(j.tanggal)}</td><td>${esc(j.kelas)}</td><td>${esc(j.materi)}</td></tr>`).join('')}
       </tbody></table></div>`
    :'<div class="empty">Belum ada pertemuan semester ini.</div>';
}

function buildFlags(att, gr, part){
  const flags=[];
  // Alpha > 3x per siswa
  students.forEach(s=>{
    const alphaCount=att.filter(a=>a.student_id===s.id&&a.status==='Alpha').length;
    if(alphaCount>=3) flags.push({level:'danger',msg:`${s.nama} (${s.kelas}) — Alpha ${alphaCount}x semester ini`});
  });
  // Nilai turun antara 2 UH terakhir
  const kelasArr=getKelasList();
  kelasArr.forEach(kelas=>{
    const uhType=periodFilter(gradeTypes).find(t=>t.kelas===kelas&&t.nama_jenis==='UH');
    if(!uhType) return;
    const namaList=getNamaPenilaianList(kelas,uhType.id);
    if(namaList.length>=2){
      const last=namaList[namaList.length-1];
      const prev=namaList[namaList.length-2];
      const avgLast=avg(gr.filter(g=>g.grade_type_id===uhType.id&&g.nama_penilaian===last).map(g=>g.nilai));
      const avgPrev=avg(gr.filter(g=>g.grade_type_id===uhType.id&&g.nama_penilaian===prev).map(g=>g.nilai));
      if(avgLast!==null&&avgPrev!==null&&avgLast<avgPrev-5){
        flags.push({level:'warn',msg:`Rata-rata ${kelas} turun dari ${prev} (${avgPrev.toFixed(1)}) ke ${last} (${avgLast.toFixed(1)})`});
      }
    }
  });
  // Siswa belum ada nilai UH
  kelasArr.forEach(kelas=>{
    const uhType=periodFilter(gradeTypes).find(t=>t.kelas===kelas&&t.nama_jenis==='UH');
    if(!uhType) return;
    const belum=studentsByClass(kelas).filter(s=>!gr.some(g=>g.student_id===s.id&&g.grade_type_id===uhType.id));
    if(belum.length>0) flags.push({level:'warn',msg:`${kelas}: ${belum.length} siswa belum ada nilai UH`});
  });
  return flags;
}

function buildKelasCard(kelas,att,part){
  const siswaKelas=studentsByClass(kelas);
  if(!siswaKelas.length) return '';

  // Hitung frekuensi per status
  const countByStudent=(status)=>siswaKelas.map(s=>({
    s, count:att.filter(a=>a.student_id===s.id&&a.status===status&&s.kelas===kelas).length
  })).sort((a,b)=>b.count-a.count).filter(x=>x.count>0).slice(0,3);

  const sakitTop=countByStudent('Sakit');
  const izinTop=countByStudent('Izin');
  const alphaTop=countByStudent('Alpha');

  // Paling aktif
  const aktifList=siswaKelas.map(s=>{
    const recs=part.filter(p=>p.student_id===s.id&&p.skor>0);
    return {s, avg:recs.length?Math.round(recs.reduce((x,r)=>x+r.skor,0)/recs.length):0, count:recs.length};
  }).filter(x=>x.count>0).sort((a,b)=>b.avg-a.avg).slice(0,3);

  const renderTop=(list,label,color)=>list.length
    ?list.map((x,i)=>`<span style="font-size:.8rem;">${i+1}. ${esc(x.s.nama)} <span style="color:${color};font-weight:700;">(${x.count}x)</span></span>`).join('<br>')
    :`<span style="color:var(--text-dim);font-size:.78rem;">Tidak ada data</span>`;

  return `<div class="card" style="margin-bottom:12px;">
    <h3 style="margin-bottom:10px;">Kelas ${kelas}</h3>
    <div class="grid grid-2" style="gap:10px;">
      <div>
        <div style="font-size:.75rem;font-weight:700;color:var(--text-dim);margin-bottom:6px;">PERHATIAN KHUSUS</div>
        <div style="margin-bottom:8px;">
          <div style="font-size:.72rem;color:var(--warn);font-weight:700;margin-bottom:3px;">🤒 SERING SAKIT</div>
          ${renderTop(sakitTop,'var(--warn)','')}
        </div>
        <div style="margin-bottom:8px;">
          <div style="font-size:.72rem;color:var(--accent);font-weight:700;margin-bottom:3px;">📋 SERING IZIN</div>
          ${renderTop(izinTop,'var(--accent)','')}
        </div>
        <div>
          <div style="font-size:.72rem;color:var(--bad);font-weight:700;margin-bottom:3px;">❌ SERING ALPHA</div>
          ${renderTop(alphaTop,'var(--bad)','')}
        </div>
      </div>
      <div>
        <div style="font-size:.75rem;font-weight:700;color:var(--text-dim);margin-bottom:6px;">PALING AKTIF</div>
        ${aktifList.length
          ?aktifList.map((x,i)=>`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:6px 8px;background:var(--panel-2);border-radius:6px;">
              <span style="font-size:1rem;">${['🥇','🥈','🥉'][i]}</span>
              <div><div style="font-size:.82rem;font-weight:600;">${esc(x.s.nama)}</div>
              <div style="font-size:.72rem;color:var(--text-dim);">Rata-rata skor: <span style="color:var(--good);font-weight:700;">${x.avg}</span></div></div>
            </div>`).join('')
          :'<span style="color:var(--text-dim);font-size:.78rem;">Belum ada data keaktifan</span>'}
      </div>
    </div>
  </div>`;
}

function avg(arr){ return arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:null; }

// ============================================================
// PERTEMUAN (Jurnal + Absensi gabung)
// ============================================================
let currentAttMap={};

function initPertemuanForm(){
  document.getElementById('jTanggal').value=today();
  loadJurnalAbsensiForm();
  populateJournalTPSelect();
}
document.addEventListener('change',e=>{
  if(e.target.id==='jTanggal'||e.target.id==='jKelas') loadJurnalAbsensiForm();
});

function loadJurnalAbsensiForm(){
  const kelas=document.getElementById('jKelas').value;
  const tanggal=document.getElementById('jTanggal').value;
  currentAttMap={};
  // cek apakah sudah ada jurnal untuk tanggal+kelas ini
  const existing=periodFilter(journalEntries).find(j=>j.tanggal===tanggal&&j.kelas===kelas);
  if(existing){
    document.getElementById('jMateri').value=existing.materi||'';
    document.getElementById('jJamKe').value=existing.jam_ke||'';
    document.getElementById('jMetode').value=existing.metode||'';
    document.getElementById('jKendala').value=existing.kendala||'';
    document.getElementById('jCatatan').value=existing.catatan||'';
    document.getElementById('jTP').value=existing.kd||'';
    document.getElementById('jSaveBtn').textContent='Update Jurnal & Absensi';
    document.getElementById('jExistingNote').textContent=`Data pertemuan ${fmtDate(tanggal)} kelas ${kelas} sudah ada — akan diupdate.`;
  } else {
    ['jMateri','jJamKe','jMetode','jKendala','jCatatan'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('jTP').value='';
    document.getElementById('jSaveBtn').textContent='Simpan Pertemuan & Absensi';
    document.getElementById('jExistingNote').textContent='';
  }
  // Load absensi existing
  studentsByClass(kelas).forEach(s=>{
    const ex=periodFilter(attendanceRecords).find(a=>a.student_id===s.id&&a.tanggal===tanggal);
    currentAttMap[s.id]=ex?ex.status:'Hadir';
  });
  renderAttGrid(studentsByClass(kelas));
}

function renderAttGrid(list){
  const items=list.map(s=>{
    const st=currentAttMap[s.id];
    return `<div class="attendance-row">
      <div><span class="no mono">${s.no_urut}.</span><span class="nm">${esc(s.nama)}</span></div>
      <div class="att-buttons">
        <button class="att-btn h ${st==='Hadir'?'sel':''}" onclick="setAtt('${s.id}','Hadir')">H</button>
        <button class="att-btn s ${st==='Sakit'?'sel':''}" onclick="setAtt('${s.id}','Sakit')">S</button>
        <button class="att-btn i ${st==='Izin'?'sel':''}" onclick="setAtt('${s.id}','Izin')">I</button>
        <button class="att-btn a ${st==='Alpha'?'sel':''}" onclick="setAtt('${s.id}','Alpha')">A</button>
      </div>
    </div>`;
  });
  // Bagi menjadi 2 kolom
  const half=Math.ceil(items.length/2);
  const col1=items.slice(0,half);
  const col2=items.slice(half);
  document.getElementById('attendanceGrid').innerHTML=
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 10px;">
      <div>${col1.join('')}</div>
      <div>${col2.join('')}</div>
    </div>`;
}
function setAtt(id,st){ currentAttMap[id]=st; renderAttGrid(studentsByClass(document.getElementById('jKelas').value)); }
function markAllHadir(){ studentsByClass(document.getElementById('jKelas').value).forEach(s=>currentAttMap[s.id]='Hadir'); renderAttGrid(studentsByClass(document.getElementById('jKelas').value)); }

async function savePertemuan(){
  const tanggal=document.getElementById('jTanggal').value;
  const kelas=document.getElementById('jKelas').value;
  const materi=document.getElementById('jMateri').value.trim();
  if(!tanggal||!materi){ showToast('Tanggal dan materi wajib diisi','error'); return; }

  const jEntry={
    tanggal, kelas,
    jam_ke:document.getElementById('jJamKe').value.trim(),
    kd:document.getElementById('jTP').value||null,
    metode:document.getElementById('jMetode').value.trim(),
    materi,
    kendala:document.getElementById('jKendala').value.trim(),
    catatan:document.getElementById('jCatatan').value.trim(),
    teacher_id:currentTeacher.id,
    semester:settings.semester_aktif,
    tahun_ajaran:settings.tahun_ajaran_aktif
  };

  setSync('busy','Menyimpan...');
  try{
    // Cek existing jurnal
    const existing=periodFilter(journalEntries).find(j=>j.tanggal===tanggal&&j.kelas===kelas);
    let journalId;
    if(existing){
      const {error}=await sb.from('journal_entries').update(jEntry).eq('id',existing.id);
      if(error) throw error;
      Object.assign(existing,jEntry);
      journalId=existing.id;
    } else {
      const {data,error}=await sb.from('journal_entries').insert(jEntry).select().single();
      if(error) throw error;
      journalEntries.unshift(data);
      journalId=data.id;
    }

    // Simpan absensi
    const studentIds=studentsByClass(kelas).map(s=>s.id);
    await sb.from('attendance').delete().eq('tanggal',tanggal).in('student_id',studentIds);
    const attRows=studentsByClass(kelas).map(s=>({
      tanggal, kelas, student_id:s.id, status:currentAttMap[s.id]||'Hadir',
      journal_entry_id:journalId, teacher_id:currentTeacher.id,
      semester:settings.semester_aktif, tahun_ajaran:settings.tahun_ajaran_aktif
    }));
    const {data:attData,error:attErr}=await sb.from('attendance').insert(attRows).select();
    if(attErr) throw attErr;
    // Update local cache
    attendanceRecords=attendanceRecords.filter(a=>!(a.tanggal===tanggal&&studentIds.includes(a.student_id)));
    attendanceRecords.push(...attData);

    setSync('','Tersinkron'); showToast('Pertemuan & absensi tersimpan');
    document.getElementById('jExistingNote').textContent=`Data pertemuan ${fmtDate(tanggal)} kelas ${kelas} sudah ada — akan diupdate.`;
    document.getElementById('jSaveBtn').textContent='Update Jurnal & Absensi';
    renderJournalList(); renderDashboard();
  } catch(err){ setSync('err','Gagal'); showToast('Gagal: '+err.message,'error'); }
}

function renderJournalList(){
  const fKelas=document.getElementById('jurnalFilterKelas').value;
  const list=periodFilter(journalEntries).filter(j=>!fKelas||j.kelas===fKelas);
  const tbody=document.querySelector('#journalTable tbody');
  document.getElementById('journalEmpty').style.display=list.length?'none':'block';
  tbody.innerHTML=list.map(j=>{
    const attForDay=periodFilter(attendanceRecords).filter(a=>a.tanggal===j.tanggal&&a.kelas===j.kelas);
    const sakit=attForDay.filter(a=>a.status==='Sakit');
    const izin=attForDay.filter(a=>a.status==='Izin');
    const alpha=attForDay.filter(a=>a.status==='Alpha');
    const hadir=attForDay.filter(a=>a.status==='Hadir').length;
    let attSummary=`<span style="color:var(--good);">H:${hadir}</span>`;
    if(sakit.length) attSummary+=` <span style="color:var(--warn);">S:${sakit.length}</span>`;
    if(izin.length) attSummary+=` <span style="color:var(--accent);">I:${izin.length}</span>`;
    if(alpha.length) attSummary+=` <span style="color:var(--bad);">A:${alpha.length}</span>`;
    const notHadir=[...sakit,...izin,...alpha];
    const notHadirNames=notHadir.length?`<div style="font-size:.72rem;color:var(--text-dim);margin-top:2px;">${notHadir.map(a=>`${studentName(a.student_id)} (${a.status[0]})`).join(', ')}</div>`:'';
    return `<tr>
      <td class="mono" style="white-space:nowrap;">${fmtDate(j.tanggal)}</td>
      <td>${esc(j.kelas)}</td>
      <td>${esc(j.jam_ke||'-')}</td>
      <td style="font-size:.78rem;">${j.kd?tpLabel(j.kd,true):'-'}</td>
      <td>${esc(j.materi)}</td>
      <td><div class="mono" style="font-size:.82rem;">${attSummary}</div>${notHadirNames}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteJurnal('${j.id}')">Hapus</button></td>
    </tr>`;
  }).join('');
}

async function deleteJurnal(id){
  if(!confirm('Hapus pertemuan ini?')) return;
  try{
    await sb.from('journal_entries').delete().eq('id',id);
    journalEntries=journalEntries.filter(j=>j.id!==id);
    renderJournalList(); showToast('Pertemuan dihapus');
  } catch(err){ showToast('Gagal: '+err.message,'error'); }
}

function populateJournalTPSelect(){
  const sel=document.getElementById('jTP');
  if(!sel)return;
  sel.innerHTML='<option value="">— Pilih TP (opsional) —</option>'
    +myFilter(learningObjectives).map(t=>`<option value="${t.id}">${esc(t.nomor_tp)} — ${esc(t.deskripsi.slice(0,55))}${t.deskripsi.length>55?'…':''}</option>`).join('');
}

// ============================================================
// EXCEL STYLING — SheetJS cell.s approach (bekerja di browser)
// ============================================================
const XS = {
  // Style presets
  title:  (txt)=>({ v:txt, t:'s', s:{ fill:{patternType:'solid',fgColor:{rgb:'1A3A5C'}}, font:{bold:true,color:{rgb:'FFFFFF'},sz:14}, alignment:{horizontal:'center',vertical:'center'} }}),
  hdr1:   (txt,bg='1A3A5C')=>({ v:txt, t:'s', s:{ fill:{patternType:'solid',fgColor:{rgb:bg}}, font:{bold:true,color:{rgb:'FFFFFF'},sz:11}, alignment:{horizontal:'center',vertical:'center',wrapText:true}, border:XS.bAll('#888888') }}),
  hdr2:   (txt,bg='2D5FA8')=>({ v:txt, t:'s', s:{ fill:{patternType:'solid',fgColor:{rgb:bg}}, font:{bold:true,color:{rgb:'FFFFFF'},sz:10}, alignment:{horizontal:'center',vertical:'center',wrapText:true}, border:XS.bAll('#888888') }}),
  cell:   (v,ri,opts={})=>{
    const even=ri%2===0;
    const bgRgb=opts.bg||(even?'FFFFFF':'EEF3FB');
    const fontColor=opts.color||'1A1D27';
    return { v: v===null||v===undefined?'':v, t: typeof v==='number'?'n':'s',
      s:{ fill:{patternType:'solid',fgColor:{rgb:bgRgb}}, font:{bold:!!opts.bold,color:{rgb:fontColor},sz:10}, alignment:{horizontal:opts.align||'left',vertical:'center'}, border:XS.bAll('#DDDDEE') }};
  },
  bAll:   (c='AAAAAA')=>({ top:{style:'thin',color:{rgb:c}}, bottom:{style:'thin',color:{rgb:c}}, left:{style:'thin',color:{rgb:c}}, right:{style:'thin',color:{rgb:c}} }),
  blank:  ()=>({ v:'', t:'s', s:{ fill:{patternType:'solid',fgColor:{rgb:'F5F7FF'}}, border:XS.bAll('#DDDDEE') }}),
};

function buildSheet(opts){
  // opts: { title, cols:[{label,w}], rows:[[cell,...]], header2:[label,...], mergesExtra:[] }
  const ncols=opts.cols.length;
  const aoa=[];
  const merges=[];

  // Row 0: Title
  aoa.push([XS.title(opts.title), ...Array(ncols-1).fill(XS.blank())]);
  merges.push({s:{r:0,c:0},e:{r:0,c:ncols-1}});

  // Row 1: Header 1
  const h1row=opts.cols.map((c,ci)=>XS.hdr1(c.label, c.bg));
  aoa.push(h1row);
  // Row 2: Header 2 (optional)
  let dataStartRow=2;
  if(opts.header2){
    aoa.push(opts.header2.map((lbl,ci)=>XS.hdr2(lbl, opts.cols[ci]&&opts.cols[ci].bg2||'2D5FA8')));
    dataStartRow=3;
  }
  // Data rows
  opts.rows.forEach((row,ri)=>{
    aoa.push(row.map((cell,ci)=>{
      if(cell&&typeof cell==='object'&&'_xs' in cell) return cell._xs; // pre-built
      if(cell&&typeof cell==='object'){
        const bgOverride=cell.bg||(ri%2===0?'FFFFFF':'EEF3FB');
        const fontColor=cell.color||'1A1D27';
        return { v:cell.v===null||cell.v===undefined?'':cell.v, t:typeof cell.v==='number'?'n':'s',
          s:{ fill:{patternType:'solid',fgColor:{rgb:bgOverride}}, font:{bold:!!cell.bold,color:{rgb:fontColor.replace('#','')},sz:10}, alignment:{horizontal:cell.align||'left',vertical:'center'}, border:XS.bAll() }};
      }
      return XS.cell(cell, ri);
    }));
  });
  // Build sheet
  const ws=XLSX.utils.aoa_to_sheet(aoa.map(row=>row.map(cell=>typeof cell==='object'?{v:cell.v,t:cell.t}:{v:cell,t:'s'})));
  // Apply styles
  aoa.forEach((row,ri)=>{ row.forEach((cell,ci)=>{ if(cell&&cell.s){ const addr=XLSX.utils.encode_cell({r:ri,c:ci}); if(ws[addr]) ws[addr].s=cell.s; } }); });
  ws['!merges']=merges.concat(opts.mergesExtra||[]);
  ws['!cols']=opts.cols.map(c=>({wch:c.w||12}));
  ws['!rows']=[{hpt:24},{hpt:20}];
  return ws;
}

// ============================================================
// EXPORT FUNCTIONS — pakai buildSheet
// ============================================================
async function exportJurnalXLSX(){
  const fKelas=document.getElementById('jurnalFilterKelas').value;
  const list=periodFilter(journalEntries).filter(j=>!fKelas||j.kelas===fKelas);
  if(!list.length){ showToast('Tidak ada data untuk diexport','error'); return; }
  const wb=XLSX.utils.book_new();
  const rows=list.map((j,ri)=>{
    const attForDay=periodFilter(attendanceRecords).filter(a=>a.tanggal===j.tanggal&&a.kelas===j.kelas);
    const sakit=attForDay.filter(a=>a.status==='Sakit');
    const izin=attForDay.filter(a=>a.status==='Izin');
    const alpha=attForDay.filter(a=>a.status==='Alpha');
    const hadir=attForDay.filter(a=>a.status==='Hadir').length;
    const notHadir=[...sakit,...izin,...alpha].map(a=>`${studentName(a.student_id)}(${a.status[0]})`).join(', ');
    const tpObj=j.kd?learningObjectives.find(t=>t.id===j.kd):null;
    const bg=ri%2===0?'FFFFFF':'EEF3FB';
    return [
      XS.cell(j.tanggal,ri,{align:'center'}),
      XS.cell(j.kelas,ri,{align:'center',bold:true}),
      XS.cell(j.jam_ke||'-',ri,{align:'center'}),
      XS.cell(tpObj?tpObj.nomor_tp:'-',ri,{align:'center',bold:true,color:'1A3A5C'}),
      XS.cell(tpObj?tpObj.deskripsi:'-',ri),
      XS.cell(j.metode||'-',ri),
      XS.cell(j.materi,ri),
      XS.cell(j.kendala||'-',ri),
      XS.cell(j.catatan||'-',ri),
      {v:hadir,t:'n',s:{fill:{patternType:'solid',fgColor:{rgb:bg}},font:{bold:true,color:{rgb:'1A6640'},sz:11},alignment:{horizontal:'center'},border:XS.bAll()}},
      {v:sakit.length||0,t:'n',s:{fill:{patternType:'solid',fgColor:{rgb:bg}},font:{bold:false,color:{rgb:sakit.length?'7A5C00':'888888'},sz:10},alignment:{horizontal:'center'},border:XS.bAll()}},
      {v:izin.length||0,t:'n',s:{fill:{patternType:'solid',fgColor:{rgb:bg}},font:{bold:false,color:{rgb:izin.length?'1A3A7A':'888888'},sz:10},alignment:{horizontal:'center'},border:XS.bAll()}},
      {v:alpha.length||0,t:'n',s:{fill:{patternType:'solid',fgColor:{rgb:bg}},font:{bold:false,color:{rgb:alpha.length?'C0392B':'888888'},sz:10},alignment:{horizontal:'center'},border:XS.bAll()}},
      XS.cell(notHadir||'-',ri,{color:notHadir?'C0392B':'888888'}),
    ];
  });
  const ws=buildSheet({
    title:`Jurnal Mengajar — ${currentTeacher.nama} — ${settings.semester_aktif} ${settings.tahun_ajaran_aktif}`,
    cols:[
      {label:'Tanggal',w:12},{label:'Kelas',w:7},{label:'Jam Ke',w:7},
      {label:'No TP',w:10},{label:'Deskripsi Tujuan Pembelajaran',w:45},
      {label:'Metode',w:20},{label:'Materi',w:40},
      {label:'Kendala',w:25},{label:'Catatan',w:20},
      {label:'H',w:5,bg:'1A6640'},{label:'S',w:5,bg:'7A5C00'},{label:'I',w:5,bg:'1A3A7A'},{label:'A',w:5,bg:'7A1A1A'},
      {label:'Nama Tidak Hadir',w:40},
    ],
    rows
  });
  XLSX.utils.book_append_sheet(wb,ws,'Jurnal');
  XLSX.writeFile(wb,`Jurnal_${settings.semester_aktif}_${settings.tahun_ajaran_aktif}_${today()}.xlsx`,{cellStyles:true});
  showToast('Jurnal berhasil diexport ✓');
}

async function exportKeaktifanXLSX(){
  const kelas=document.getElementById('partRekapKelas').value;
  const list=studentsByClass(kelas);
  const dates=[...new Set(periodFilter(participations).filter(p=>list.some(s=>s.id===p.student_id)).map(p=>p.tanggal))].sort();
  const wb=XLSX.utils.book_new();
  const rows=list.map((s,ri)=>{
    const cells=[XS.cell(s.no_urut,ri,{align:'center'}),XS.cell(s.nama,ri,{bold:true})];
    let total=0,count=0;
    dates.forEach(d=>{
      const rec=periodFilter(participations).find(p=>p.student_id===s.id&&p.tanggal===d);
      const skor=rec?rec.skor:0;
      if(skor>0){total+=skor;count++;}
      const bg=ri%2===0?'FFFFFF':'EEF3FB';
      cells.push(skor>0?{v:skor,t:'n',s:{fill:{patternType:'solid',fgColor:{rgb:bg}},font:{sz:10,color:{rgb:'1A6640'}},alignment:{horizontal:'center'},border:XS.bAll()}}
        :{v:'',t:'s',s:{fill:{patternType:'solid',fgColor:{rgb:bg}},alignment:{horizontal:'center'},border:XS.bAll()}});
    });
    const avg=count?Math.round(total/count):0;
    cells.push({v:total,t:'n',s:{fill:{patternType:'solid',fgColor:{rgb:ri%2===0?'E8F5EE':'D4EDE0'}},font:{bold:true,color:{rgb:'1A6640'},sz:11},alignment:{horizontal:'center'},border:XS.bAll()}});
    cells.push({v:avg||'',t:avg?'n':'s',s:{fill:{patternType:'solid',fgColor:{rgb:ri%2===0?'E8F5EE':'D4EDE0'}},font:{bold:true,color:{rgb:avg&&avg<settings.kkm?'C0392B':'1A6640'},sz:11},alignment:{horizontal:'center'},border:XS.bAll()}});
    return cells;
  });
  const ws=buildSheet({
    title:`Rekap Keaktifan Kelas ${kelas} — ${settings.semester_aktif} ${settings.tahun_ajaran_aktif}`,
    cols:[{label:'No',w:5},{label:'Nama Siswa',w:28},...dates.map(d=>({label:fmtDateShort(d),w:10})),{label:'Total Skor',w:11,bg:'1A5C3A'},{label:'Rata-rata',w:11,bg:'1A5C3A'}],
    rows
  });
  XLSX.utils.book_append_sheet(wb,ws,`Keaktifan ${kelas}`);
  XLSX.writeFile(wb,`Keaktifan_${kelas}_${settings.semester_aktif}_${today()}.xlsx`,{cellStyles:true});
  showToast('Keaktifan berhasil diexport ✓');
}

async function exportKejadianXLSX(){
  const list=periodFilter(incidents);
  if(!list.length){ showToast('Tidak ada data','error'); return; }
  const wb=XLSX.utils.book_new();
  const tingkatColor={Ringan:'1A6640',Sedang:'7A5C00',Berat:'C0392B'};
  const statusColor={'Open':'C0392B','Closed':'1A6640'};
  const rows=list.map((i,ri)=>{
    const s=studentObj(i.student_id);
    return [
      XS.cell(i.tanggal,ri,{align:'center'}),
      XS.cell(s?s.nama:'?',ri,{bold:true}),
      XS.cell(s?s.kelas:'?',ri,{align:'center'}),
      XS.cell(i.jenis,ri),
      {v:i.tingkat,t:'s',s:{fill:{patternType:'solid',fgColor:{rgb:ri%2===0?'FFFFFF':'EEF3FB'}},font:{bold:true,color:{rgb:tingkatColor[i.tingkat]||'333333'},sz:10},alignment:{horizontal:'center'},border:XS.bAll()}},
      XS.cell(i.deskripsi,ri),
      XS.cell(i.tindak_lanjut||'-',ri),
      {v:i.status==='Open'?'Terbuka':'Selesai',t:'s',s:{fill:{patternType:'solid',fgColor:{rgb:i.status==='Closed'?'E8F5EE':'FDECEA'}},font:{bold:true,color:{rgb:statusColor[i.status]||'333333'},sz:10},alignment:{horizontal:'center'},border:XS.bAll()}},
    ];
  });
  const ws=buildSheet({
    title:`Catatan Kejadian — ${currentTeacher.nama} — ${settings.semester_aktif} ${settings.tahun_ajaran_aktif}`,
    cols:[{label:'Tanggal',w:12},{label:'Nama Siswa',w:28},{label:'Kelas',w:7},{label:'Jenis',w:12},{label:'Tingkat',w:9},{label:'Deskripsi',w:45},{label:'Tindak Lanjut',w:35},{label:'Status',w:10}],
    rows
  });
  XLSX.utils.book_append_sheet(wb,ws,'Kejadian');
  XLSX.writeFile(wb,`Kejadian_${settings.semester_aktif}_${today()}.xlsx`,{cellStyles:true});
  showToast('Kejadian berhasil diexport ✓');
}

async function exportSiswaXLSX(){
  const kelas=document.getElementById('siswaFilterKelas').value;
  const list=kelas?studentsByClass(kelas):students;
  if(!list.length){ showToast('Tidak ada data','error'); return; }
  const wb=XLSX.utils.book_new();
  const rows=list.map((s,ri)=>[
    XS.cell(ri+1,ri,{align:'center'}),
    XS.cell(s.no_urut,ri,{align:'center'}),
    XS.cell(s.nama,ri,{bold:true}),
    XS.cell(s.kelas,ri,{align:'center'}),
    XS.cell(s.jk==='L'?'Laki-laki':'Perempuan',ri),
    XS.cell(s.nisn||'-',ri,{align:'center'}),
  ]);
  const ws=buildSheet({
    title:`Daftar Siswa${kelas?' Kelas '+kelas:''} — ${currentTeacher.nama}`,
    cols:[{label:'No',w:5},{label:'No. Urut',w:9},{label:'Nama Siswa',w:32},{label:'Kelas',w:10},{label:'Jenis Kelamin',w:14},{label:'NISN',w:14}],
    rows
  });
  XLSX.utils.book_append_sheet(wb,ws,kelas?`Kelas ${kelas}`:'Semua Siswa');
  XLSX.writeFile(wb,`DaftarSiswa${kelas?'_'+kelas:''}_${today()}.xlsx`,{cellStyles:true});
  showToast('Daftar siswa berhasil diexport ✓');
}

// ============================================================
// KEAKTIFAN
// ============================================================
// KEAKTIFAN
// ============================================================
let currentPartMap={};
function loadParticipationForm(){
  const kelas=document.getElementById('pKelas').value;
  const tanggal=document.getElementById('pTanggal').value;
  currentPartMap={};
  studentsByClass(kelas).forEach(s=>{
    const ex=periodFilter(participations).find(p=>p.student_id===s.id&&p.tanggal===tanggal);
    currentPartMap[s.id]=ex?ex.skor:0;
  });
  renderPartGrid(studentsByClass(kelas));
}
function renderPartGrid(list){
  const items=list.map(s=>{
    const skor=currentPartMap[s.id]||0;
    return `<div class="attendance-row">
      <div style="flex:1;min-width:0;"><span class="no mono">${s.no_urut}.</span><span class="nm">${esc(s.nama)}</span></div>
      <div style="display:flex;align-items:center;gap:5px;flex-shrink:0;">
        <div class="part-btns">
          <button class="part-quick" onclick="addPart('${s.id}',10)">+10</button>
          <button class="part-quick" onclick="addPart('${s.id}',25)">+25</button>
          <button class="part-quick" onclick="setPart('${s.id}',100)">MAX</button>
          <button class="part-quick" onclick="setPart('${s.id}',0)" style="color:var(--bad);">✕</button>
        </div>
        <input type="number" min="0" max="100" value="${skor}" class="part-score"
          onchange="currentPartMap['${s.id}']=Math.min(100,Math.max(0,parseInt(this.value)||0));this.value=currentPartMap['${s.id}']">
      </div>
    </div>`;
  });
  const half=Math.ceil(items.length/2);
  document.getElementById('participationGrid').innerHTML=
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 10px;">
      <div>${items.slice(0,half).join('')}</div>
      <div>${items.slice(half).join('')}</div>
    </div>`;
}
function addPart(id,d){ currentPartMap[id]=Math.min(100,(currentPartMap[id]||0)+d); renderPartGrid(studentsByClass(document.getElementById('pKelas').value)); }
function setPart(id,v){ currentPartMap[id]=v; renderPartGrid(studentsByClass(document.getElementById('pKelas').value)); }
function resetAllPart(){ studentsByClass(document.getElementById('pKelas').value).forEach(s=>currentPartMap[s.id]=0); renderPartGrid(studentsByClass(document.getElementById('pKelas').value)); }

async function saveParticipation(){
  const kelas=document.getElementById('pKelas').value;
  const tanggal=document.getElementById('pTanggal').value;
  if(!tanggal){ showToast('Pilih tanggal','error'); return; }
  const sIds=studentsByClass(kelas).map(s=>s.id);
  setSync('busy','Menyimpan...');
  try{
    await sb.from('participation').delete().eq('tanggal',tanggal).in('student_id',sIds);
    const rows=studentsByClass(kelas).map(s=>({
      tanggal,kelas,student_id:s.id,skor:currentPartMap[s.id]||0,
      teacher_id:currentTeacher.id,semester:settings.semester_aktif,tahun_ajaran:settings.tahun_ajaran_aktif
    }));
    const {data,error}=await sb.from('participation').insert(rows).select();
    if(error) throw error;
    participations=participations.filter(p=>!(p.tanggal===tanggal&&sIds.includes(p.student_id)));
    participations.push(...data);
    setSync('','Tersinkron'); showToast('Keaktifan tersimpan');
    renderParticipationRecap(); renderDashboard();
  } catch(err){ setSync('err','Gagal'); showToast('Gagal: '+err.message,'error'); }
}

function renderParticipationRecap(){
  const kelas=document.getElementById('partRekapKelas').value;
  document.querySelector('#partRekapTable tbody').innerHTML=studentsByClass(kelas).map(s=>{
    const recs=periodFilter(participations).filter(p=>p.student_id===s.id&&p.skor>0);
    const total=recs.reduce((x,r)=>x+r.skor,0);
    const av=recs.length?Math.round(total/recs.length):null;
    return `<tr><td class="mono">${s.no_urut}</td><td>${esc(s.nama)}</td><td class="mono">${recs.length}x</td><td class="mono">${total}</td><td class="mono" style="font-weight:700;">${av!==null?av:'-'}</td></tr>`;
  }).join('');
}

// ============================================================
// CATATAN KEJADIAN
// ============================================================
function populateStudentSelect(selId,kelasFilter=null){
  const sel=document.getElementById(selId);
  if(!sel)return;
  const list=kelasFilter?studentsByClass(kelasFilter):students;
  sel.innerHTML=list.map(s=>`<option value="${s.id}">${esc(s.nama)} (${s.kelas})</option>`).join('');
}
function populateIncidentStudentFilter(){
  const kf=document.getElementById('incidentFilterKelas').value;
  const sel=document.getElementById('incidentFilterStudent');
  const cur=sel.value;
  const list=kf?studentsByClass(kf):students;
  sel.innerHTML='<option value="">Semua Siswa</option>'+list.map(s=>`<option value="${s.id}">${esc(s.nama)} (${s.kelas})</option>`).join('');
  if(list.find(s=>s.id===cur)) sel.value=cur;
}
async function saveIncident(){
  const e={
    tanggal:document.getElementById('iTanggal').value,
    student_id:document.getElementById('iSiswa').value,
    jenis:document.getElementById('iJenis').value,
    tingkat:document.getElementById('iTingkat').value,
    deskripsi:document.getElementById('iDeskripsi').value.trim(),
    tindak_lanjut:document.getElementById('iTindakLanjut').value.trim(),
    status:'Open', teacher_id:currentTeacher.id,
    semester:settings.semester_aktif, tahun_ajaran:settings.tahun_ajaran_aktif
  };
  if(!e.tanggal||!e.student_id||!e.deskripsi){ showToast('Tanggal, siswa, deskripsi wajib diisi','error'); return; }
  setSync('busy','Menyimpan...');
  try{
    const {data,error}=await sb.from('incidents').insert(e).select();
    if(error) throw error;
    incidents.unshift(data[0]);
    setSync('','Tersinkron'); showToast('Catatan tersimpan');
    document.getElementById('iDeskripsi').value=''; document.getElementById('iTindakLanjut').value='';
    renderIncidentList(); renderDashboard();
  } catch(err){ setSync('err','Gagal'); showToast('Gagal: '+err.message,'error'); }
}
function renderIncidentList(){
  const kf=document.getElementById('incidentFilterKelas').value;
  const sf=document.getElementById('incidentFilterStudent').value;
  let list=periodFilter(incidents);
  if(sf) list=list.filter(i=>i.student_id===sf);
  else if(kf){ const ids=new Set(studentsByClass(kf).map(s=>s.id)); list=list.filter(i=>ids.has(i.student_id)); }
  document.getElementById('incidentEmpty').style.display=list.length?'none':'block';
  document.querySelector('#incidentTable tbody').innerHTML=list.map(i=>`
    <tr>
      <td class="mono">${fmtDate(i.tanggal)}</td><td>${esc(studentName(i.student_id))}</td>
      <td>${esc(i.jenis)}</td><td><span class="badge badge-${i.tingkat.toLowerCase()}">${i.tingkat}</span></td>
      <td>${esc(i.deskripsi)}</td>
      <td><span class="badge badge-${i.status.toLowerCase()}" style="cursor:pointer;" onclick="toggleIncident('${i.id}','${i.status}')">${i.status==='Open'?'Terbuka':'Selesai'}</span></td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteIncident('${i.id}')">Hapus</button></td>
    </tr>`).join('');
}
async function toggleIncident(id,cur){
  const ns=cur==='Open'?'Closed':'Open';
  try{
    await sb.from('incidents').update({status:ns}).eq('id',id);
    incidents.find(i=>i.id===id).status=ns;
    renderIncidentList(); renderDashboard();
  } catch(err){ showToast('Gagal: '+err.message,'error'); }
}
async function deleteIncident(id){
  if(!confirm('Hapus catatan ini?')) return;
  try{
    await sb.from('incidents').delete().eq('id',id);
    incidents=incidents.filter(i=>i.id!==id);
    showToast('Dihapus'); renderIncidentList(); renderDashboard();
  } catch(err){ showToast('Gagal: '+err.message,'error'); }
}
// ============================================================
// NILAI
// ============================================================
function loadGradeForm(){
  const kelas=document.getElementById('gKelas').value;
  const types=periodFilter(gradeTypes).filter(g=>g.kelas===kelas);
  document.getElementById('gJenis').innerHTML=types.map(t=>`<option value="${t.id}">${esc(t.nama_jenis)} (${t.bobot}%)</option>`).join('');
  loadNamaPenilaianList();
  populateGradeTP();
}
function populateGradeTP(){
  const sel=document.getElementById('gTP');
  if(!sel)return;
  sel.innerHTML='<option value="">— Pilih TP (opsional) —</option>'
    +myFilter(learningObjectives).map(t=>`<option value="${t.id}">${esc(t.nomor_tp)} — ${esc(t.deskripsi.slice(0,50))}${t.deskripsi.length>50?'…':''}</option>`).join('');
}
function loadNamaPenilaianList(){
  const kelas=document.getElementById('gKelas').value;
  const gtId=document.getElementById('gJenis').value;
  const namaList=getNamaPenilaianList(kelas,gtId);
  const sel=document.getElementById('gNamaSelect');
  sel.innerHTML='<option value="">— Pilih nama penilaian —</option>'+namaList.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join('');
  document.getElementById('gNamaBaru').value='';
  renderGradeInputTable('','');
}
function onSelectNamaPenilaian(){
  const nama=document.getElementById('gNamaSelect').value;
  document.getElementById('gNamaBaru').value='';
  if(nama){
    const kelas=document.getElementById('gKelas').value;
    const gtId=document.getElementById('gJenis').value;
    const sample=periodFilter(grades).find(g=>g.nama_penilaian===nama&&g.grade_type_id===gtId&&studentsByClass(kelas).some(s=>s.id===g.student_id));
    if(sample){
      if(sample.tanggal) document.getElementById('gTanggal').value=sample.tanggal;
      if(sample.tp_id) document.getElementById('gTP').value=sample.tp_id;
    }
  }
  renderGradeInputTable(document.getElementById('gJenis').value,nama);
}
function onTypeNamaBaru(){
  document.getElementById('gNamaSelect').value='';
  renderGradeInputTable(document.getElementById('gJenis').value,'');
}
function getActiveNama(){ return document.getElementById('gNamaBaru').value.trim()||document.getElementById('gNamaSelect').value; }
function renderGradeInputTable(gtId,namaPenilaian){
  const kelas=document.getElementById('gKelas').value;
  const list=studentsByClass(kelas);
  const half=Math.ceil(list.length/2);
  const col1=list.slice(0,half);
  const col2=list.slice(half);
  function rowHtml(s){
    let existing='';
    if(namaPenilaian&&gtId){
      const g=periodFilter(grades).find(x=>x.student_id===s.id&&x.grade_type_id===gtId&&x.nama_penilaian===namaPenilaian);
      if(g) existing=g.nilai;
    }
    return `<div class="attendance-row">
      <div style="flex:1;min-width:0;"><span class="no mono">${s.no_urut}.</span><span class="nm">${esc(s.nama)}</span></div>
      <input type="number" min="0" max="100" step="0.01" data-student="${s.id}"
        class="grade-input" placeholder="0–100" value="${existing}"
        style="width:78px;text-align:center;padding:5px 7px;flex-shrink:0;">
    </div>`;
  }
  document.getElementById('gradeInputTable').innerHTML=
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 10px;">
      <div>${col1.map(rowHtml).join('')}</div>
      <div>${col2.map(rowHtml).join('')}</div>
    </div>`;
}
function clearGradeInputs(){
  document.querySelectorAll('.grade-input').forEach(i=>i.value='');
  document.getElementById('gNamaSelect').value='';
  document.getElementById('gNamaBaru').value='';
}
async function saveGrades(){
  const kelas=document.getElementById('gKelas').value;
  const gtId=document.getElementById('gJenis').value;
  const nama=getActiveNama();
  const tanggal=document.getElementById('gTanggal').value;
  const tpId=document.getElementById('gTP').value||null;
  if(!gtId||!nama){ showToast('Pilih atau ketik nama penilaian','error'); return; }
  const newRows=[]; const updateRows=[];
  document.querySelectorAll('.grade-input').forEach(inp=>{
    if(inp.value.trim()==='') return;
    const n=parseFloat(inp.value);
    if(isNaN(n)||n<0||n>100) return;
    const sid=inp.dataset.student;
    const ex=periodFilter(grades).find(g=>g.student_id===sid&&g.grade_type_id===gtId&&g.nama_penilaian===nama);
    if(ex) updateRows.push({id:ex.id,nilai:n,tanggal,tp_id:tpId});
    else newRows.push({student_id:sid,grade_type_id:gtId,nama_penilaian:nama,nilai:n,tanggal,tp_id:tpId,teacher_id:currentTeacher.id,semester:settings.semester_aktif,tahun_ajaran:settings.tahun_ajaran_aktif});
  });
  if(!newRows.length&&!updateRows.length){ showToast('Belum ada nilai yang diisi','error'); return; }
  setSync('busy','Menyimpan...');
  try{
    if(newRows.length){
      const {data,error}=await sb.from('grades').insert(newRows).select();
      if(error) throw error;
      grades.push(...data);
    }
    for(const u of updateRows){
      const {data,error}=await sb.from('grades').update({nilai:u.nilai,tanggal:u.tanggal,tp_id:u.tp_id}).eq('id',u.id).select();
      if(error) throw error;
      const idx=grades.findIndex(g=>g.id===u.id);
      if(idx>=0&&data[0]) grades[idx]=data[0];
    }
    setSync('','Tersinkron'); showToast(`${newRows.length} baru + ${updateRows.length} diperbarui`);
    loadNamaPenilaianList();
    setTimeout(()=>{ document.getElementById('gNamaSelect').value=nama; onSelectNamaPenilaian(); },100);
    renderFinalGrades(); renderDashboard();
  } catch(err){ setSync('err','Gagal'); showToast('Gagal: '+err.message,'error'); }
}
function renderWeightSettings(){
  const kelas=document.getElementById('wKelas').value;
  const types=periodFilter(gradeTypes).filter(g=>g.kelas===kelas);
  document.getElementById('weightSettings').innerHTML=
    `<div class="grid grid-4">${types.map(t=>`<div class="field"><label>${esc(t.nama_jenis)}</label>
      <input type="number" min="0" max="100" value="${t.bobot}" data-typeid="${t.id}" class="weight-input" onchange="updateWeightTotal()"></div>`).join('')}</div>
    <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="saveWeights()">Simpan Bobot</button>`;
  updateWeightTotal();
}
function updateWeightTotal(){
  let tot=0; document.querySelectorAll('.weight-input').forEach(i=>tot+=parseFloat(i.value)||0);
  const el=document.getElementById('weightTotal');
  el.textContent=`Total bobot: ${tot}%`+(tot!==100?' — sebaiknya 100%':' ✓');
  el.style.color=tot===100?'var(--good)':'var(--warn)';
}
async function saveWeights(){
  const updates=[...document.querySelectorAll('.weight-input')].map(i=>({id:i.dataset.typeid,bobot:parseFloat(i.value)||0}));
  setSync('busy','Menyimpan...');
  try{
    for(const u of updates){
      await sb.from('grade_types').update({bobot:u.bobot}).eq('id',u.id);
      const gt=gradeTypes.find(g=>g.id===u.id); if(gt) gt.bobot=u.bobot;
    }
    setSync('','Tersinkron'); showToast('Bobot tersimpan'); renderFinalGrades(); loadGradeForm();
  } catch(err){ setSync('err','Gagal'); showToast('Gagal: '+err.message,'error'); }
}
function renderFinalGrades(){
  const kelas=document.getElementById('finalKelas').value;
  const list=studentsByClass(kelas);
  const types=periodFilter(gradeTypes).filter(g=>g.kelas===kelas);
  const pg=periodFilter(grades);
  const pp=periodFilter(participations);

  const typeColumns=[];
  types.forEach(t=>{
    if(t.nama_jenis==='Keaktifan'){
      typeColumns.push({typeId:t.id,typeName:'Keaktifan',bobot:t.bobot,namaPenilaian:'Rata-rata',isKeaktifan:true});
    } else {
      const names=getNamaPenilaianList(kelas,t.id);
      if(!names.length) typeColumns.push({typeId:t.id,typeName:t.nama_jenis,bobot:t.bobot,namaPenilaian:'(belum ada)',isEmpty:true});
      else names.forEach(n=>typeColumns.push({typeId:t.id,typeName:t.nama_jenis,bobot:t.bobot,namaPenilaian:n}));
    }
  });

  const typeGroups={};
  typeColumns.forEach(c=>{ if(!typeGroups[c.typeName]) typeGroups[c.typeName]=[]; typeGroups[c.typeName].push(c); });

  let h1='<tr><th rowspan="2">No</th><th rowspan="2">Nama</th>';
  Object.entries(typeGroups).forEach(([tn,cols])=>{
    h1+=`<th colspan="${cols.length}" style="text-align:center;border-left:2px solid var(--border);">${esc(tn)} <small style="font-weight:400;">(${cols[0].bobot}%)</small></th>`;
  });
  h1+='<th rowspan="2" style="border-left:2px solid var(--border);">Nilai Akhir</th></tr>';

  let h2='<tr>';
  typeColumns.forEach((c,i)=>{
    const bl=i===0||typeColumns[i-1].typeName!==c.typeName?'border-left:2px solid var(--border);':'';
    h2+=`<th style="font-size:.7rem;white-space:nowrap;${bl}">${esc(c.namaPenilaian)}</th>`;
  });
  h2+='</tr>';

  let body='<tbody>';
  list.forEach(s=>{
    const avgPT={};
    types.forEach(t=>{
      if(t.nama_jenis==='Keaktifan'){
        const pr=pp.filter(p=>p.student_id===s.id&&p.skor>0);
        avgPT[t.id]=pr.length?Math.round(pr.reduce((x,r)=>x+r.skor,0)/pr.length):null;
      } else {
        const sg=pg.filter(g=>g.student_id===s.id&&g.grade_type_id===t.id);
        avgPT[t.id]=sg.length?sg.reduce((x,g)=>x+g.nilai,0)/sg.length:null;
      }
    });
    let finalScore=0,hasAny=false;
    types.forEach(t=>{ if(avgPT[t.id]!==null){ hasAny=true; finalScore+=avgPT[t.id]*(t.bobot/100); } });

    let row=`<tr><td class="mono">${s.no_urut}</td><td style="cursor:pointer;color:var(--accent);" onclick="showProfilSiswa('${s.id}')">${esc(s.nama)}</td>`;
    typeColumns.forEach((c,i)=>{
      const bl=i===0||typeColumns[i-1].typeName!==c.typeName?'border-left:2px solid var(--border);':'';
      if(c.isKeaktifan){
        const v=avgPT[c.typeId]; row+=`<td class="mono" style="${bl}">${v!==null?v:'-'}</td>`;
      } else if(c.isEmpty){
        row+=`<td style="${bl}color:var(--text-dim);">-</td>`;
      } else {
        const g=pg.find(x=>x.student_id===s.id&&x.grade_type_id===c.typeId&&x.nama_penilaian===c.namaPenilaian);
        const val=g?g.nilai.toFixed(1):'-';
        const color=g&&g.nilai<settings.kkm?'color:var(--bad);':'';
        row+=`<td class="mono" style="${bl}${color}">${val}</td>`;
      }
    });
    const naColor=hasAny&&finalScore<settings.kkm?'color:var(--bad);':'';
    row+=`<td class="mono" style="font-weight:700;border-left:2px solid var(--border);${naColor}">${hasAny?finalScore.toFixed(1):'-'}</td></tr>`;
    body+=row;
  });
  body+='</tbody>';
  document.getElementById('finalGradeTable').innerHTML=`<thead>${h1}${h2}</thead>${body}`;

  // Analitik grafik
  renderGradeChart(kelas, types, typeColumns, pg, pp, list);
}

function renderGradeChart(kelas, types, typeColumns, pg, pp, list){
  const container=document.getElementById('gradeChartContainer');
  if(!container) return;
  // Grafik tren rata-rata per nama penilaian per jenis (bukan Keaktifan)
  const charts=[];
  types.filter(t=>t.nama_jenis!=='Keaktifan').forEach(t=>{
    const names=getNamaPenilaianList(kelas,t.id);
    if(names.length<1) return;
    const avgs=names.map(n=>{
      const vals=list.map(s=>pg.find(g=>g.student_id===s.id&&g.grade_type_id===t.id&&g.nama_penilaian===n)).filter(Boolean).map(g=>g.nilai);
      return vals.length?(vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1):null;
    }).filter(v=>v!==null);
    if(avgs.length) charts.push({label:t.nama_jenis,names,avgs});
  });

  if(!charts.length){ container.innerHTML='<div class="empty">Belum ada data nilai untuk ditampilkan grafiknya.</div>'; return; }

  const svgH=160; const svgW=500; const pad=40;
  container.innerHTML=charts.map(ch=>{
    const maxV=Math.max(...ch.avgs.map(Number),100);
    const minV=Math.max(0,Math.min(...ch.avgs.map(Number))-10);
    const range=maxV-minV||1;
    const n=ch.avgs.length;
    const pts=ch.avgs.map((v,i)=>({
      x:pad+(i/(Math.max(n-1,1)))*(svgW-pad*2),
      y:(svgH-pad)-(((Number(v)-minV)/range)*(svgH-pad*1.5))
    }));
    const polyline=pts.map(p=>`${p.x},${p.y}`).join(' ');
    const kkml=((svgH-pad)-(((settings.kkm-minV)/range)*(svgH-pad*1.5)));
    return `<div style="margin-bottom:16px;">
      <div style="font-size:.82rem;font-weight:700;margin-bottom:6px;">${esc(ch.label)} — Tren Rata-rata Kelas ${kelas}</div>
      <svg viewBox="0 0 ${svgW} ${svgH}" style="width:100%;max-width:${svgW}px;height:${svgH}px;background:var(--panel-2);border-radius:8px;">
        <!-- KKM line -->
        <line x1="${pad}" y1="${kkml}" x2="${svgW-pad}" y2="${kkml}" stroke="var(--bad)" stroke-width="1" stroke-dasharray="4,3" opacity=".6"/>
        <text x="${svgW-pad+3}" y="${kkml+4}" font-size="9" fill="var(--bad)" opacity=".8">KKM</text>
        <!-- Axes -->
        <line x1="${pad}" y1="${pad/2}" x2="${pad}" y2="${svgH-pad}" stroke="var(--border)" stroke-width="1"/>
        <line x1="${pad}" y1="${svgH-pad}" x2="${svgW-pad}" y2="${svgH-pad}" stroke="var(--border)" stroke-width="1"/>
        <!-- Line -->
        <polyline points="${polyline}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
        <!-- Dots & labels -->
        ${pts.map((p,i)=>`
          <circle cx="${p.x}" cy="${p.y}" r="5" fill="var(--accent)"/>
          <text x="${p.x}" y="${p.y-9}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--text)">${ch.avgs[i]}</text>
          <text x="${p.x}" y="${svgH-pad+14}" text-anchor="middle" font-size="9" fill="var(--text-dim)">${esc(ch.names[i].slice(0,10))}</text>
        `).join('')}
      </svg>
    </div>`;
  }).join('');
}

async function exportGradesXLSX(){
  const kelas=document.getElementById('finalKelas').value;
  const list=studentsByClass(kelas);
  const types=periodFilter(gradeTypes).filter(g=>g.kelas===kelas);
  const pg=periodFilter(grades);
  const pp=periodFilter(participations);
  const typeColumns=[];
  types.forEach(t=>{
    if(t.nama_jenis==='Keaktifan') typeColumns.push({typeId:t.id,typeName:'Keaktifan',bobot:t.bobot,namaPenilaian:'Rata-rata Keaktifan',isKeaktifan:true});
    else {
      const names=getNamaPenilaianList(kelas,t.id);
      if(!names.length) typeColumns.push({typeId:t.id,typeName:t.nama_jenis,bobot:t.bobot,namaPenilaian:'(belum ada)',isEmpty:true});
      else names.forEach(n=>typeColumns.push({typeId:t.id,typeName:t.nama_jenis,bobot:t.bobot,namaPenilaian:n}));
    }
  });
  const wb=XLSX.utils.book_new();
  const typeGroups={};
  typeColumns.forEach(c=>{ if(!typeGroups[c.typeName]) typeGroups[c.typeName]=[]; typeGroups[c.typeName].push(c); });
  const typeGroupsArr=Object.entries(typeGroups);
  const title=`Rekap Nilai ${currentTeacher.mapel} Kelas ${kelas} — ${settings.semester_aktif} ${settings.tahun_ajaran_aktif}`;

  // Flatten kolom: No, Nama, lalu setiap typeGroup → setiap kolom penilaian, lalu Nilai Akhir
  // Header baris 1: No | Nama | [Type Name (bobot%) colspan=N] ... | Nilai Akhir
  // Header baris 2: ''  | ''  | [nama penilaian per kolom] ... | ''
  const cols=[{label:'No',w:5},{label:'Nama Siswa',w:28}];
  const header2Labels=['',''];
  typeGroupsArr.forEach(([tn,cols2])=>{
    cols2.forEach((c,ci)=>{ cols.push({label:tn+(ci===0?` (${c.bobot}%)`:''),w:13,bg:ci===0?'1A3A5C':'2A4F80'}); });
    cols2.forEach(c=>header2Labels.push(c.namaPenilaian));
  });
  cols.push({label:'Nilai Akhir',w:13,bg:'1A5C3A'});
  header2Labels.push('');

  const styledRows=list.map((s,ri)=>{
    const avgPT={};
    types.forEach(t=>{
      if(t.nama_jenis==='Keaktifan'){ const pr=pp.filter(p=>p.student_id===s.id&&p.skor>0); avgPT[t.id]=pr.length?Math.round(pr.reduce((x,r)=>x+r.skor,0)/pr.length):null; }
      else { const sg=pg.filter(g=>g.student_id===s.id&&g.grade_type_id===t.id); avgPT[t.id]=sg.length?sg.reduce((x,g)=>x+g.nilai,0)/sg.length:null; }
    });
    let finalScore=0,hasAny=false;
    types.forEach(t=>{ if(avgPT[t.id]!==null){ hasAny=true; finalScore+=avgPT[t.id]*(t.bobot/100); } });
    const row=[XS.cell(s.no_urut,ri,{align:'center'}),XS.cell(s.nama,ri,{bold:true})];
    typeColumns.forEach(c=>{
      const bg=ri%2===0?'FFFFFF':'EEF3FB';
      if(c.isEmpty){ row.push({v:'-',t:'s',s:{fill:{patternType:'solid',fgColor:{rgb:bg}},font:{color:{rgb:'AAAAAA'},sz:10},alignment:{horizontal:'center'},border:XS.bAll()}}); }
      else if(c.typeId&&types.find(t=>t.id===c.typeId&&t.nama_jenis==='Keaktifan')){
        const v=avgPT[c.typeId]; const belowKkm=v!==null&&v<settings.kkm;
        row.push({v:v!==null?v:'',t:typeof v==='number'?'n':'s',s:{fill:{patternType:'solid',fgColor:{rgb:belowKkm?'FDECEA':bg}},font:{bold:false,color:{rgb:belowKkm?'C0392B':'1A6640'},sz:10},alignment:{horizontal:'center'},border:XS.bAll()}});
      } else {
        const g=pg.find(x=>x.student_id===s.id&&x.grade_type_id===c.typeId&&x.nama_penilaian===c.namaPenilaian);
        const val=g?parseFloat(g.nilai.toFixed(1)):null;
        const belowKkm=g&&g.nilai<settings.kkm;
        row.push({v:val!==null?val:'',t:val!==null?'n':'s',s:{fill:{patternType:'solid',fgColor:{rgb:belowKkm?'FDECEA':g?'E8F5EE':bg}},font:{bold:false,color:{rgb:belowKkm?'C0392B':g?'1A6640':'888888'},sz:10},alignment:{horizontal:'center'},border:XS.bAll()}});
      }
    });
    const naVal=hasAny?parseFloat(finalScore.toFixed(1)):null;
    const naBelowKkm=hasAny&&finalScore<settings.kkm;
    row.push({v:naVal!==null?naVal:'',t:naVal!==null?'n':'s',s:{fill:{patternType:'solid',fgColor:{rgb:naBelowKkm?'FDECEA':'D4EDE0'}},font:{bold:true,color:{rgb:naBelowKkm?'C0392B':'1A5C3A'},sz:11},alignment:{horizontal:'center'},border:XS.bAll()}});
    return row;
  });

  const ws=buildSheet({ title, cols, header2:header2Labels, rows:styledRows });
  XLSX.utils.book_append_sheet(wb,ws,`Nilai ${kelas}`);
  XLSX.writeFile(wb,`Nilai_${kelas}_${settings.semester_aktif}_${today()}.xlsx`,{cellStyles:true});
  showToast('Nilai berhasil diexport ✓');
}

// ============================================================
// TUJUAN PEMBELAJARAN
// ============================================================
async function saveTP(){
  const nomor=document.getElementById('tpNomor').value.trim();
  const deskripsi=document.getElementById('tpDeskripsi').value.trim();
  if(!nomor||!deskripsi){ showToast('Nomor TP dan deskripsi wajib diisi','error'); return; }
  const maxU=learningObjectives.length?Math.max(...learningObjectives.map(x=>x.urutan||0)):0;
  setSync('busy','Menyimpan...');
  try{
    const {data,error}=await sb.from('learning_objectives').insert({
      nomor_tp:nomor, deskripsi,
      kelas:document.getElementById('tpKelas').value,
      semester:document.getElementById('tpSemester').value,
      tahun_ajaran:document.getElementById('tpTA').value.trim(),
      urutan:maxU+1, teacher_id:currentTeacher.id
    }).select();
    if(error) throw error;
    learningObjectives.push(data[0]);
    setSync('','Tersinkron'); showToast('TP tersimpan');
    document.getElementById('tpNomor').value=''; document.getElementById('tpDeskripsi').value='';
    populateJournalTPSelect(); populateGradeTP(); renderTPList();
  } catch(err){ setSync('err','Gagal'); showToast('Gagal: '+err.message,'error'); }
}
function renderTPList(){
  const kf=document.getElementById('tpFilterKelas').value;
  const sf=document.getElementById('tpFilterSemester').value;
  let list=myFilter(learningObjectives);
  if(kf) list=list.filter(t=>t.kelas===kf);
  if(sf) list=list.filter(t=>t.semester===sf);
  list.sort((a,b)=>(a.urutan||0)-(b.urutan||0));
  const container=document.getElementById('tpList');
  if(!list.length){ container.innerHTML='<div class="empty">Belum ada Tujuan Pembelajaran.</div>'; return; }
  container.innerHTML=list.map(t=>`
    <div class="tp-item">
      <div class="tp-nomor">${esc(t.nomor_tp)}</div>
      <div style="flex:1;">
        <div class="tp-desc">${esc(t.deskripsi)}</div>
        <div class="tp-meta">${esc(t.kelas)} · ${esc(t.semester||'')} ${esc(t.tahun_ajaran||'')}</div>
        <div class="tp-actions" style="margin-top:6px;">
          <button class="btn btn-danger btn-sm" onclick="deleteTP('${t.id}')">Hapus</button>
        </div>
      </div>
    </div>`).join('');
}
async function deleteTP(id){
  if(!confirm('Hapus TP ini?')) return;
  try{
    await sb.from('learning_objectives').delete().eq('id',id);
    learningObjectives=learningObjectives.filter(t=>t.id!==id);
    populateJournalTPSelect(); populateGradeTP(); renderTPList(); showToast('TP dihapus');
  } catch(err){ showToast('Gagal: '+err.message,'error'); }
}

// ============================================================
// KALENDER
// ============================================================
let calYear=new Date().getFullYear();
let calMonth=new Date().getMonth();

function renderKalender(){
  const y=calYear, m=calMonth;
  const firstDay=new Date(y,m,1).getDay();
  const daysInMonth=new Date(y,m+1,0).getDate();
  const monthName=new Date(y,m,1).toLocaleDateString('id-ID',{month:'long',year:'numeric'});
  document.getElementById('calTitle').textContent=monthName;

  const j=periodFilter(journalEntries);
  const a=periodFilter(attendanceRecords);
  const inc=periodFilter(incidents);

  // Map: date string -> {hasJurnal, hasSIA, hasIncident}
  const dayMap={};
  j.forEach(je=>{
    if(!je.tanggal) return;
    const [yr,mo,da]=je.tanggal.split('-');
    if(parseInt(yr)===y&&parseInt(mo)-1===m){
      if(!dayMap[da]) dayMap[da]={jurnal:[],sia:false,incident:false};
      dayMap[da].jurnal.push(je);
    }
  });
  a.forEach(ae=>{
    if(!ae.tanggal) return;
    const [yr,mo,da]=ae.tanggal.split('-');
    if(parseInt(yr)===y&&parseInt(mo)-1===m&&ae.status!=='Hadir'){
      const k=da.padStart(2,'0');
      if(!dayMap[k]) dayMap[k]={jurnal:[],sia:false,incident:false};
      dayMap[k].sia=true;
    }
  });
  inc.forEach(ie=>{
    if(!ie.tanggal) return;
    const [yr,mo,da]=ie.tanggal.split('-');
    if(parseInt(yr)===y&&parseInt(mo)-1===m){
      const k=da.padStart(2,'0');
      if(!dayMap[k]) dayMap[k]={jurnal:[],sia:false,incident:false};
      dayMap[k].incident=true;
    }
  });

  const days=['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
  let html=`<div class="cal-grid">${days.map(d=>`<div class="cal-head">${d}</div>`).join('')}`;
  for(let i=0;i<(firstDay===0?6:firstDay-1);i++) html+='<div class="cal-cell empty"></div>';
  for(let d=1;d<=daysInMonth;d++){
    const ds=String(d).padStart(2,'0');
    const info=dayMap[ds];
    const isToday=new Date().getFullYear()===y&&new Date().getMonth()===m&&new Date().getDate()===d;
    const dots=info?`<div class="cal-dots">
      ${info.jurnal.length?`<span class="cal-dot" style="background:var(--good);" title="${info.jurnal.length} pertemuan"></span>`:''}
      ${info.sia?`<span class="cal-dot" style="background:var(--warn);" title="Ada ketidakhadiran"></span>`:''}
      ${info.incident?`<span class="cal-dot" style="background:var(--bad);" title="Ada kejadian"></span>`:''}
    </div>`:'';
    html+=`<div class="cal-cell${isToday?' today':''}" onclick="showCalDay('${y}-${String(m+1).padStart(2,'0')}-${ds}')">
      <div class="cal-num">${d}</div>${dots}
    </div>`;
  }
  html+='</div>';
  document.getElementById('calGrid').innerHTML=html;

  // Legend
  document.getElementById('calLegend').innerHTML=`
    <div class="cal-legend-item"><span class="cal-dot" style="background:var(--good);"></span>Ada pertemuan</div>
    <div class="cal-legend-item"><span class="cal-dot" style="background:var(--warn);"></span>Ada ketidakhadiran</div>
    <div class="cal-legend-item"><span class="cal-dot" style="background:var(--bad);"></span>Ada kejadian</div>`;
}

function calPrev(){ calMonth--; if(calMonth<0){calMonth=11;calYear--;} renderKalender(); }
function calNext(){ calMonth++; if(calMonth>11){calMonth=0;calYear++;} renderKalender(); }

function showCalDay(dateStr){
  const j=periodFilter(journalEntries).filter(x=>x.tanggal===dateStr);
  const a=periodFilter(attendanceRecords).filter(x=>x.tanggal===dateStr&&x.status!=='Hadir');
  const inc=periodFilter(incidents).filter(x=>x.tanggal===dateStr);
  let html=`<div style="font-size:.9rem;font-weight:700;margin-bottom:10px;">${fmtDate(dateStr)}</div>`;
  if(j.length){
    html+=`<div style="font-size:.78rem;font-weight:700;color:var(--good);margin-bottom:4px;">PERTEMUAN</div>`;
    j.forEach(je=>html+=`<div style="font-size:.82rem;padding:4px 0;border-bottom:1px solid var(--border);">${esc(je.kelas)} — ${esc(je.materi)}</div>`);
  }
  if(a.length){
    html+=`<div style="font-size:.78rem;font-weight:700;color:var(--warn);margin-top:8px;margin-bottom:4px;">KETIDAKHADIRAN</div>`;
    a.forEach(ae=>html+=`<div style="font-size:.82rem;">${esc(studentName(ae.student_id))} — ${esc(ae.status)}</div>`);
  }
  if(inc.length){
    html+=`<div style="font-size:.78rem;font-weight:700;color:var(--bad);margin-top:8px;margin-bottom:4px;">KEJADIAN</div>`;
    inc.forEach(ie=>html+=`<div style="font-size:.82rem;">${esc(studentName(ie.student_id))} — ${esc(ie.deskripsi.slice(0,50))}</div>`);
  }
  if(!j.length&&!a.length&&!inc.length) html+='<div class="empty" style="padding:12px;">Tidak ada data untuk hari ini.</div>';
  document.getElementById('calDayDetail').innerHTML=html;
}

// ============================================================
// PROFIL SISWA
// ============================================================
function renderProfilList(){
  const kelas=document.getElementById('profilFilterKelas').value;
  const list=studentsByClass(kelas);
  document.getElementById('profilList').innerHTML=list.map(s=>`
    <div class="profil-card" onclick="showProfilSiswa('${s.id}')">
      <div class="profil-avatar">${s.nama.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()}</div>
      <div><div style="font-weight:700;font-size:.9rem;">${esc(s.nama)}</div>
      <div style="font-size:.75rem;color:var(--text-dim);">${s.jk==='L'?'Laki-laki':'Perempuan'} · NISN: ${s.nisn||'-'}</div></div>
    </div>`).join('');
  document.getElementById('profilDetail').innerHTML='<div class="empty">Klik nama siswa untuk melihat profil lengkap.</div>';
}

function showProfilSiswa(id){
  const s=studentObj(id);
  if(!s) return;
  const att=periodFilter(attendanceRecords).filter(a=>a.student_id===id);
  const h=att.filter(a=>a.status==='Hadir').length;
  const sk=att.filter(a=>a.status==='Sakit').length;
  const iz=att.filter(a=>a.status==='Izin').length;
  const al=att.filter(a=>a.status==='Alpha').length;
  const pct=att.length?Math.round(h/att.length*100):0;

  const part=periodFilter(participations).filter(p=>p.student_id===id&&p.skor>0);
  const avgPart=part.length?Math.round(part.reduce((x,r)=>x+r.skor,0)/part.length):null;

  const gradeList=periodFilter(grades).filter(g=>g.student_id===id);
  const types=periodFilter(gradeTypes).filter(t=>t.kelas===s.kelas);
  const avgPerType={};
  types.forEach(t=>{
    if(t.nama_jenis==='Keaktifan') avgPerType[t.nama_jenis]=avgPart;
    else {
      const sg=gradeList.filter(g=>g.grade_type_id===t.id);
      avgPerType[t.nama_jenis]=sg.length?sg.reduce((x,g)=>x+g.nilai,0)/sg.length:null;
    }
  });
  let finalScore=0,hasAny=false;
  types.forEach(t=>{ if(avgPerType[t.nama_jenis]!==null){ hasAny=true; finalScore+=avgPerType[t.nama_jenis]*(t.bobot/100); } });

  const incList=periodFilter(incidents).filter(i=>i.student_id===id);

  document.getElementById('profilDetail').innerHTML=`
    <div class="profil-header">
      <div class="profil-avatar-lg">${s.nama.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()}</div>
      <div>
        <div style="font-size:1.1rem;font-weight:800;">${esc(s.nama)}</div>
        <div style="font-size:.8rem;color:var(--text-dim);">${s.kelas} · ${s.jk==='L'?'Laki-laki':'Perempuan'} · NISN: ${esc(s.nisn||'-')}</div>
      </div>
    </div>

    <div class="grid grid-4" style="margin:14px 0;">
      <div class="stat"><div class="num">${pct}%</div><div class="lbl">Kehadiran</div></div>
      <div class="stat"><div class="num">${al}</div><div class="lbl">Alpha</div></div>
      <div class="stat"><div class="num">${avgPart!==null?avgPart:'-'}</div><div class="lbl">Rata-rata Keaktifan</div></div>
      <div class="stat"><div class="num" style="${hasAny&&finalScore<settings.kkm?'color:var(--bad)':''}">${hasAny?finalScore.toFixed(1):'-'}</div><div class="lbl">Nilai Akhir</div></div>
    </div>

    <div style="font-size:.82rem;font-weight:700;color:var(--text-dim);margin-bottom:8px;">KEHADIRAN</div>
    <div style="display:flex;gap:12px;margin-bottom:14px;">
      <span style="color:var(--good);">Hadir: ${h}</span>
      <span style="color:var(--warn);">Sakit: ${sk}</span>
      <span style="color:var(--accent);">Izin: ${iz}</span>
      <span style="color:var(--bad);">Alpha: ${al}</span>
    </div>

    <div style="font-size:.82rem;font-weight:700;color:var(--text-dim);margin-bottom:8px;">NILAI PER JENIS</div>
    <div class="table-wrap"><table style="font-size:.82rem;margin-bottom:14px;"><thead><tr><th>Jenis</th><th>Bobot</th><th>Rata-rata</th><th>Status</th></tr></thead><tbody>
      ${types.map(t=>{
        const v=avgPerType[t.nama_jenis];
        const status=v===null?'—':v>=settings.kkm?'<span style="color:var(--good);">✓ Tuntas</span>':'<span style="color:var(--bad);">✗ Remidi</span>';
        return `<tr><td>${esc(t.nama_jenis)}</td><td>${t.bobot}%</td><td class="mono">${v!==null?Number(v).toFixed(1):'-'}</td><td>${status}</td></tr>`;
      }).join('')}
    </tbody></table></div>

    <div style="font-size:.82rem;font-weight:700;color:var(--text-dim);margin-bottom:8px;">CATATAN KEJADIAN (${incList.length})</div>
    ${incList.length
      ?`<div class="table-wrap"><table style="font-size:.82rem;"><thead><tr><th>Tanggal</th><th>Jenis</th><th>Deskripsi</th><th>Status</th></tr></thead><tbody>
        ${incList.map(i=>`<tr><td>${fmtDate(i.tanggal)}</td><td>${esc(i.jenis)}</td><td>${esc(i.deskripsi)}</td><td><span class="badge badge-${i.status.toLowerCase()}">${i.status==='Open'?'Terbuka':'Selesai'}</span></td></tr>`).join('')}
        </tbody></table></div>`
      :'<div class="empty" style="padding:8px;">Tidak ada catatan kejadian.</div>'}`;

  // Scroll ke detail
  document.getElementById('profilDetail').scrollIntoView({behavior:'smooth',block:'nearest'});
}

// ============================================================
// PENGATURAN
// ============================================================
function renderPengaturanTab(){
  updatePeriodBadge();
  if(currentTeacher.is_admin) renderTeacherList();
}

function renderTeacherList(){
  const container=document.getElementById('teacherList');
  if(!container) return;
  container.innerHTML=teachers.map(t=>`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--panel-2);border-radius:7px;margin-bottom:6px;">
      <div>
        <div style="font-weight:700;font-size:.88rem;">${esc(t.nama)} ${t.is_admin?'<span style="color:var(--accent);font-size:.72rem;">[Admin]</span>':''}</div>
        <div style="font-size:.75rem;color:var(--text-dim);">@${esc(t.username)} · ${esc(t.mapel)}</div>
      </div>
      <div style="display:flex;gap:6px;">
        ${!t.is_admin?`<button class="btn btn-danger btn-sm" onclick="deleteTeacher('${t.id}')">Hapus</button>`:''}
        <button class="btn btn-secondary btn-sm" onclick="resetTeacherPw('${t.id}','${esc(t.nama)}')">Reset PW</button>
      </div>
    </div>`).join('');
}

async function addTeacher(){
  const nama=document.getElementById('newTeacherNama').value.trim();
  const uname=document.getElementById('newTeacherUsername').value.trim();
  const mapel=document.getElementById('newTeacherMapel').value.trim();
  const pw=document.getElementById('newTeacherPw').value;
  if(!nama||!uname||!pw){ showToast('Nama, username, password wajib diisi','error'); return; }
  setSync('busy','Menyimpan...');
  try{
    const hash=await sha256(pw);
    const {data,error}=await sb.from('teachers').insert({nama,username:uname,password_hash:hash,mapel:mapel||'Matematika',is_admin:false}).select();
    if(error) throw error;
    teachers.push(data[0]);
    setSync('','Tersinkron'); showToast('Guru berhasil ditambahkan');
    ['newTeacherNama','newTeacherUsername','newTeacherMapel','newTeacherPw'].forEach(id=>document.getElementById(id).value='');
    renderTeacherList();
  } catch(err){ setSync('err','Gagal'); showToast('Gagal: '+err.message,'error'); }
}

async function deleteTeacher(id){
  if(!confirm('Hapus akun guru ini?')) return;
  try{
    await sb.from('teachers').update({aktif:false}).eq('id',id);
    teachers=teachers.filter(t=>t.id!==id);
    renderTeacherList(); showToast('Akun dihapus');
  } catch(err){ showToast('Gagal: '+err.message,'error'); }
}

async function resetTeacherPw(id,nama){
  const newPw=prompt(`Reset password untuk ${nama}.\nMasukkan password baru:`);
  if(!newPw) return;
  try{
    const hash=await sha256(newPw);
    await sb.from('teachers').update({password_hash:hash}).eq('id',id);
    showToast('Password berhasil direset');
  } catch(err){ showToast('Gagal: '+err.message,'error'); }
}

async function savePeriodSettings(){
  settings.semester_aktif=document.getElementById('settingSemester').value;
  settings.tahun_ajaran_aktif=document.getElementById('settingTA').value.trim();
  settings.kkm=parseInt(document.getElementById('settingKKM').value)||75;
  await saveSettings();
  updatePeriodBadge();
  showToast('Pengaturan tersimpan — data difilter ulang');
  await loadAll();
  renderDashboard();
}

// Backup & Restore & Delete (sama seperti versi lama tapi dengan filter teacher)
async function backupAllData(){
  showToast('Menyiapkan backup...'); setSync('busy','Backup...');
  try{
    const [s,j,a,inc,gt,g,p,lo]=await Promise.all([
      sb.from('students').select('*').eq('teacher_id',currentTeacher.id),
      sb.from('journal_entries').select('*').eq('teacher_id',currentTeacher.id),
      sb.from('attendance').select('*').eq('teacher_id',currentTeacher.id),
      sb.from('incidents').select('*').eq('teacher_id',currentTeacher.id),
      sb.from('grade_types').select('*').eq('teacher_id',currentTeacher.id),
      sb.from('grades').select('*').eq('teacher_id',currentTeacher.id),
      sb.from('participation').select('*').eq('teacher_id',currentTeacher.id),
      sb.from('learning_objectives').select('*').eq('teacher_id',currentTeacher.id)
    ]);
    const backup={
      meta:{exported_at:new Date().toISOString(),app:'Jurnal Guru Digital',version:'3.0',
        teacher:currentTeacher.nama,semester:settings.semester_aktif,tahun_ajaran:settings.tahun_ajaran_aktif},
      students:s.data||[],journal_entries:j.data||[],attendance:a.data||[],
      incidents:inc.data||[],grade_types:gt.data||[],grades:g.data||[],
      participation:p.data||[],learning_objectives:lo.data||[]
    };
    const a2=document.createElement('a');
    a2.href=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));
    a2.download=`JurnalGuru_${currentTeacher.username}_${settings.semester_aktif}_${today()}.json`;
    a2.click();
    setSync('','Tersinkron'); showToast('Backup berhasil diunduh ✓');
  } catch(err){ setSync('err','Gagal'); showToast('Gagal backup: '+err.message,'error'); }
}

async function restoreFromBackup(){
  const input=document.createElement('input');
  input.type='file'; input.accept='.json';
  input.onchange=async(e)=>{
    const file=e.target.files[0]; if(!file) return;
    const text=await file.text();
    let backup;
    try{ backup=JSON.parse(text); } catch(err){ showToast('File JSON tidak valid','error'); return; }
    if(!backup.meta||!backup.students){
      showToast('Format backup tidak dikenali. Pastikan file dari Jurnal Guru Digital.','error'); return;
    }
    // Tampilkan modal konfirmasi restore
    const info=backup.meta;
    const summary=`Backup dari: ${info.teacher||'?'}\nTanggal: ${info.exported_at?new Date(info.exported_at).toLocaleString('id'):'-'}\nSemester: ${info.semester||'-'} ${info.tahun_ajaran||''}\n\nData yang akan direstore:\n• ${backup.students?.length||0} Siswa\n• ${backup.learning_objectives?.length||0} TP\n• ${backup.journal_entries?.length||0} Jurnal\n• ${backup.attendance?.length||0} Absensi\n• ${backup.participation?.length||0} Keaktifan\n• ${backup.grades?.length||0} Nilai\n• ${backup.incidents?.length||0} Kejadian\n\n⚠ Data yang sama di database akan DILEWATI (tidak ditimpa).`;
    document.getElementById('restoreModalInfo').textContent=summary;
    document.getElementById('restoreModal').classList.add('open');
    // Simpan backup di memory untuk dieksekusi
    window._pendingRestore=backup;
  };
  input.click();
}

async function executeRestore(){
  const backup=window._pendingRestore;
  if(!backup){ showToast('Tidak ada data backup','error'); return; }
  document.getElementById('restoreModal').classList.remove('open');
  setSync('busy','Restore...');
  const results={success:0,skip:0,error:0};

  // Mapping tabel → state lokal
  const tableMap=[
    {key:'students',         table:'students',           stateArr:()=>students,         setArr:(d)=>students=d},
    {key:'learning_objectives',table:'learning_objectives',stateArr:()=>learningObjectives,setArr:(d)=>learningObjectives=d},
    {key:'journal_entries',  table:'journal_entries',    stateArr:()=>journalEntries,   setArr:(d)=>journalEntries=d},
    {key:'attendance',       table:'attendance',         stateArr:()=>attendanceRecords,setArr:(d)=>attendanceRecords=d},
    {key:'participation',    table:'participation',      stateArr:()=>participations,   setArr:(d)=>participations=d},
    {key:'grade_types',      table:'grade_types',        stateArr:()=>gradeTypes,       setArr:(d)=>gradeTypes=d},
    {key:'grades',           table:'grades',             stateArr:()=>grades,           setArr:(d)=>grades=d},
    {key:'incidents',        table:'incidents',          stateArr:()=>incidents,        setArr:(d)=>incidents=d},
  ];

  try{
    for(const {key,table,stateArr,setArr} of tableMap){
      const rows=(backup[key]||[]).map(row=>{
        // Paksa teacher_id ke guru yang sedang login
        const r={...row,teacher_id:currentTeacher.id};
        // Hapus field yang tidak ada di schema (id tetap ada untuk upsert conflict)
        return r;
      });
      if(!rows.length) continue;
      // upsert: on_conflict=id → skip jika sudah ada, insert jika belum
      const {data,error}=await sb.from(table).upsert(rows,{onConflict:'id',ignoreDuplicates:true}).select();
      if(error){ console.warn(`Restore ${table}:`,error); results.error++; }
      else {
        results.success+=(data?.length||0);
        // Merge ke state lokal (hindari duplikat)
        const existing=stateArr();
        const existingIds=new Set(existing.map(x=>x.id));
        const newRows=(data||[]).filter(x=>!existingIds.has(x.id));
        setArr([...existing,...newRows]);
      }
    }
    setSync('','Tersinkron');
    showToast(`Restore selesai ✓ — ${results.success} record berhasil, ${results.error} error`,'success');
    updateAllKelasDropdowns();
    renderDashboard();
    delete window._pendingRestore;
  } catch(err){
    setSync('err','Gagal'); showToast('Restore gagal: '+err.message,'error');
  }
}

let pendingDeleteTarget='';
const deleteInfo={
  jurnal:{title:'Hapus Semua Jurnal',body:'Seluruh data jurnal mengajar semester ini akan dihapus.',table:'journal_entries'},
  absensi:{title:'Hapus Semua Absensi',body:'Seluruh rekap kehadiran semester ini akan dihapus.',table:'attendance'},
  keaktifan:{title:'Hapus Semua Keaktifan',body:'Seluruh skor keaktifan semester ini akan dihapus.',table:'participation'},
  kejadian:{title:'Hapus Semua Kejadian',body:'Seluruh catatan kejadian semester ini akan dihapus.',table:'incidents'},
  nilai:{title:'Hapus Semua Nilai',body:'Seluruh entri nilai semester ini akan dihapus.',table:'grades'},
  tp:{title:'Hapus Semua TP',body:'Seluruh Tujuan Pembelajaran akan dihapus.',table:'learning_objectives'},
  semua:{title:'Reset Semua Data Transaksi',body:'SEMUA data transaksi (jurnal, absensi, keaktifan, kejadian, nilai, TP) akan dihapus. Data siswa dan pengaturan bobot tetap ada.',table:null}
};
function confirmDelete(target){
  pendingDeleteTarget=target;
  const info=deleteInfo[target];
  document.getElementById('deleteModalTitle').textContent=info.title;
  document.getElementById('deleteModalBody').textContent=info.body;
  document.getElementById('deleteConfirmInput').value='';
  document.getElementById('deleteConfirmBtn').disabled=true;
  document.getElementById('deleteModal').classList.add('open');
}
function closeDeleteModal(){ document.getElementById('deleteModal').classList.remove('open'); }
function checkDeleteConfirm(){ document.getElementById('deleteConfirmBtn').disabled=document.getElementById('deleteConfirmInput').value!=='HAPUS'; }
async function executeDelete(){
  const info=deleteInfo[pendingDeleteTarget];
  closeDeleteModal(); setSync('busy','Menghapus...');
  try{
    const tables=pendingDeleteTarget==='semua'?['journal_entries','attendance','participation','incidents','grades','learning_objectives']:[info.table];
    for(const t of tables){
      await sb.from(t).delete().eq('teacher_id',currentTeacher.id);
    }
    await loadAll(); setSync('','Tersinkron'); showToast('Data berhasil dihapus'); renderDashboard();
  } catch(err){ setSync('err','Gagal'); showToast('Gagal: '+err.message,'error'); }
}
document.addEventListener('click',e=>{ if(e.target.id==='deleteModal') closeDeleteModal(); });

// ============================================================
// MANAJEMEN KELAS & SISWA
// ============================================================

// Ambil daftar kelas unik dari data siswa + daftar default tersimpan
function getKelasList(){
  const fromStudents=[...new Set(students.map(s=>s.kelas).filter(Boolean))];
  const stored=JSON.parse(localStorage.getItem('jg_kelas_list')||'[]');
  return [...new Set([...stored,...fromStudents])].sort();
}
function saveKelasList(list){ localStorage.setItem('jg_kelas_list', JSON.stringify([...new Set(list)].sort())); }

function getAllKelasOptions(selectEl, selectedVal=''){
  if(!selectEl) return;
  const list=getKelasList();
  selectEl.innerHTML=list.map(k=>`<option value="${esc(k)}" ${k===selectedVal?'selected':''}>${esc(k)}</option>`).join('');
}

function renderSiswaTab(){
  const list=getKelasList();
  // Isi semua dropdown kelas di tab siswa
  ['siswaFilterKelas','newSiswaKelas','importSiswaKelas'].forEach(id=>{
    const el=document.getElementById(id); if(!el) return;
    getAllKelasOptions(el, el.value||list[0]||'');
  });
  renderKelasList();
  renderSiswaDaftarAdmin();
  updateNoUrut();
}

function renderKelasList(){
  const list=getKelasList();
  const container=document.getElementById('kelasList');
  if(!list.length){ container.innerHTML='<div class="empty">Belum ada kelas. Tambahkan kelas di bawah.</div>'; return; }
  container.innerHTML=`<div style="display:flex;flex-wrap:wrap;gap:8px;">
    ${list.map(k=>{
      const jml=students.filter(s=>s.kelas===k).length;
      return `<div style="display:flex;align-items:center;gap:6px;background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:8px 12px;">
        <span style="font-weight:700;font-size:.9rem;">${esc(k)}</span>
        <span style="font-size:.76rem;color:var(--text-dim);">${jml} siswa</span>
        <button class="btn btn-danger btn-sm" onclick="hapusKelas('${esc(k)}')" title="Hapus kelas (hanya jika tidak ada siswa)">×</button>
      </div>`;
    }).join('')}
  </div>`;
}

function addKelas(){
  const nama=document.getElementById('newKelasNama').value.trim().toUpperCase();
  if(!nama){ showToast('Nama kelas tidak boleh kosong','error'); return; }
  const list=getKelasList();
  if(list.includes(nama)){ showToast('Kelas sudah ada','error'); return; }
  list.push(nama);
  saveKelasList(list);
  document.getElementById('newKelasNama').value='';
  // Update semua dropdown kelas di seluruh app
  updateAllKelasDropdowns();
  renderKelasList();
  showToast(`Kelas ${nama} berhasil ditambahkan`);
}

function hapusKelas(nama){
  const jml=students.filter(s=>s.kelas===nama).length;
  if(jml>0){ showToast(`Tidak bisa hapus — masih ada ${jml} siswa di kelas ${nama}. Pindahkan/hapus siswa terlebih dahulu.`,'error'); return; }
  if(!confirm(`Hapus kelas ${nama}?`)) return;
  const list=getKelasList().filter(k=>k!==nama);
  saveKelasList(list);
  updateAllKelasDropdowns();
  renderKelasList();
  showToast(`Kelas ${nama} dihapus`);
}

// Update semua dropdown kelas di seluruh app (pertemuan, keaktifan, nilai, profil, dsb)
function updateAllKelasDropdowns(){
  const list=getKelasList();
  const opts=list.map(k=>`<option value="${esc(k)}">${esc(k)}</option>`).join('');
  const multiOpts=`<option value="">Semua Kelas</option>`+opts;

  // Dropdown single-select
  ['jKelas','pKelas','gKelas','wKelas','finalKelas','partRekapKelas','profilFilterKelas'].forEach(id=>{
    const el=document.getElementById(id); if(!el) return;
    const cur=el.value;
    el.innerHTML=opts;
    if(list.includes(cur)) el.value=cur;
  });
  // Dropdown dengan opsi "Semua"
  ['jurnalFilterKelas','incidentFilterKelas'].forEach(id=>{
    const el=document.getElementById(id); if(!el) return;
    const cur=el.value;
    el.innerHTML=multiOpts;
    if(el.querySelector(`option[value="${cur}"]`)) el.value=cur;
  });
  // TP kelas filter
  const tpKelasEl=document.getElementById('tpKelas');
  if(tpKelasEl){ tpKelasEl.innerHTML='<option value="Semua">Semua Kelas</option>'+opts; }
  const tpFlKelasEl=document.getElementById('tpFilterKelas');
  if(tpFlKelasEl){ tpFlKelasEl.innerHTML='<option value="">Semua</option><option value="Semua">Lintas Kelas</option>'+opts; }
  // Tab siswa
  ['siswaFilterKelas','newSiswaKelas','importSiswaKelas'].forEach(id=>{
    const el=document.getElementById(id); if(!el) return;
    const cur=el.value;
    el.innerHTML=opts;
    if(list.includes(cur)) el.value=cur; else if(list.length) el.value=list[0];
  });
  // Modal edit siswa
  const editKelasEl=document.getElementById('editSiswaKelas');
  if(editKelasEl){ editKelasEl.innerHTML=opts; }
}

function updateNoUrut(){
  const kelas=document.getElementById('newSiswaKelas').value;
  const max=studentsByClass(kelas).reduce((m,s)=>Math.max(m,s.no_urut||0),0);
  document.getElementById('newSiswaNo').value=max+1;
}

function renderSiswaDaftarAdmin(){
  const kelas=document.getElementById('siswaFilterKelas').value;
  const list=kelas?studentsByClass(kelas):students;
  const container=document.getElementById('siswaDaftarAdmin');
  if(!list.length){ container.innerHTML='<div class="empty">Belum ada siswa di kelas ini.</div>'; return; }
  container.innerHTML=`<div class="table-wrap"><table>
    <thead><tr><th>No</th><th>Nama</th><th>Kelas</th><th>JK</th><th>NISN</th><th></th></tr></thead>
    <tbody>
      ${list.map(s=>`<tr>
        <td class="mono">${s.no_urut}</td>
        <td style="font-weight:600;">${esc(s.nama)}</td>
        <td><span style="background:var(--panel-2);border:1px solid var(--border);border-radius:5px;padding:2px 8px;font-size:.76rem;">${esc(s.kelas)}</span></td>
        <td>${s.jk==='L'?'♂ L':'♀ P'}</td>
        <td class="mono" style="font-size:.78rem;color:var(--text-dim);">${esc(s.nisn||'-')}</td>
        <td>
          <div style="display:flex;gap:4px;">
            <button class="btn btn-secondary btn-sm" onclick="openEditSiswa('${s.id}')">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="hapusSiswa('${s.id}')">Hapus</button>
          </div>
        </td>
      </tr>`).join('')}
    </tbody>
  </table></div>
  <div style="font-size:.78rem;color:var(--text-dim);margin-top:6px;">${list.length} siswa</div>`;
}

async function addSiswa(){
  const kelas=document.getElementById('newSiswaKelas').value;
  const nama=document.getElementById('newSiswaName').value.trim();
  const no=parseInt(document.getElementById('newSiswaNo').value)||0;
  const jk=document.getElementById('newSiswaJK').value;
  const nisn=document.getElementById('newSiswaNoInduk').value.trim();
  if(!nama||!kelas){ showToast('Nama dan kelas wajib diisi','error'); return; }
  if(!no||no<1){ showToast('No urut tidak valid','error'); return; }
  if(studentsByClass(kelas).some(s=>s.no_urut===no)){ showToast(`No urut ${no} sudah dipakai di kelas ${kelas}`,'error'); return; }
  setSync('busy','Menyimpan...');
  try{
    const {data,error}=await sb.from('students').insert({
      nama, kelas, no_urut:no, jk, nisn:nisn||null, teacher_id:currentTeacher.id
    }).select().single();
    if(error) throw error;
    students.push(data);
    students.sort((a,b)=>a.kelas.localeCompare(b.kelas)||(a.no_urut-b.no_urut));
    setSync('','Tersinkron');
    showToast(`${nama} berhasil ditambahkan ke kelas ${kelas}`);
    document.getElementById('newSiswaName').value='';
    document.getElementById('newSiswaNoInduk').value='';
    updateNoUrut();
    renderSiswaDaftarAdmin();
    renderDashboard();
  } catch(err){ setSync('err',''); showToast('Gagal: '+err.message,'error'); }
}

function openEditSiswa(id){
  const s=students.find(x=>x.id===id); if(!s) return;
  document.getElementById('editSiswaId').value=s.id;
  document.getElementById('editSiswaNo').value=s.no_urut;
  document.getElementById('editSiswaName').value=s.nama;
  document.getElementById('editSiswaJK').value=s.jk||'L';
  document.getElementById('editSiswaNoInduk').value=s.nisn||'';
  getAllKelasOptions(document.getElementById('editSiswaKelas'), s.kelas);
  document.getElementById('editSiswaModal').classList.add('open');
}

async function saveEditSiswa(){
  const id=document.getElementById('editSiswaId').value;
  const kelas=document.getElementById('editSiswaKelas').value;
  const nama=document.getElementById('editSiswaName').value.trim();
  const no=parseInt(document.getElementById('editSiswaNo').value)||0;
  const jk=document.getElementById('editSiswaJK').value;
  const nisn=document.getElementById('editSiswaNoInduk').value.trim();
  if(!nama||!no){ showToast('Nama dan no urut wajib diisi','error'); return; }
  setSync('busy','Menyimpan...');
  try{
    const {data,error}=await sb.from('students').update({nama,kelas,no_urut:no,jk,nisn:nisn||null}).eq('id',id).select().single();
    if(error) throw error;
    const idx=students.findIndex(s=>s.id===id);
    if(idx>=0) students[idx]=data;
    students.sort((a,b)=>a.kelas.localeCompare(b.kelas)||(a.no_urut-b.no_urut));
    setSync('','Tersinkron'); showToast('Data siswa diperbarui');
    document.getElementById('editSiswaModal').classList.remove('open');
    renderSiswaDaftarAdmin();
  } catch(err){ setSync('err',''); showToast('Gagal: '+err.message,'error'); }
}

async function hapusSiswa(id){
  const s=students.find(x=>x.id===id);
  if(!s) return;
  // Periksa apakah siswa masih punya data terkait
  const hasData=attendanceRecords.some(a=>a.student_id===id)||
    grades.some(g=>g.student_id===id)||
    participations.some(p=>p.student_id===id)||
    incidents.some(i=>i.student_id===id);
  const msg=hasData
    ?`Siswa "${s.nama}" memiliki data absensi/nilai/keaktifan.\nMenghapus siswa TIDAK akan menghapus data tersebut (akan muncul sebagai "(?)").\n\nYakin hapus?`
    :`Hapus siswa "${s.nama}" dari kelas ${s.kelas}?`;
  if(!confirm(msg)) return;
  try{
    await sb.from('students').delete().eq('id',id);
    students=students.filter(s=>s.id!==id);
    showToast('Siswa dihapus');
    renderSiswaDaftarAdmin();
    renderDashboard();
  } catch(err){ showToast('Gagal: '+err.message,'error'); }
}

function previewImport(){
  const teks=document.getElementById('importSiswaTeks').value;
  const kelas=document.getElementById('importSiswaKelas').value;
  const namaList=teks.split('\n').map(l=>l.trim()).filter(l=>l.length>0);
  if(!namaList.length){ showToast('Tempel daftar nama terlebih dahulu','error'); return; }
  const maxNo=studentsByClass(kelas).reduce((m,s)=>Math.max(m,s.no_urut||0),0);
  const preview=namaList.map((nama,i)=>{
    const duplikat=students.some(s=>s.kelas===kelas&&s.nama.toLowerCase()===nama.toLowerCase());
    return `<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;background:var(--panel-2);border-radius:6px;margin-bottom:3px;">
      <span class="mono" style="color:var(--text-dim);min-width:28px;">${maxNo+i+1}.</span>
      <span style="flex:1;">${esc(nama)}</span>
      ${duplikat?'<span style="color:var(--warn);font-size:.76rem;">⚠ nama mungkin duplikat</span>':'<span style="color:var(--good);font-size:.76rem;">✓</span>'}
    </div>`;
  });
  document.getElementById('importPreview').innerHTML=
    `<div style="font-size:.8rem;font-weight:700;margin-bottom:6px;">${namaList.length} siswa akan ditambahkan ke kelas ${kelas}:</div>`
    +preview.join('')
    +`<div class="helper" style="margin-top:6px;">Nomor urut dimulai dari ${maxNo+1}.</div>`;
  document.getElementById('importSiswaBtn').style.display='inline-flex';
}

async function importSiswaBulk(){
  const teks=document.getElementById('importSiswaTeks').value;
  const kelas=document.getElementById('importSiswaKelas').value;
  const namaList=teks.split('\n').map(l=>l.trim()).filter(l=>l.length>0);
  if(!namaList.length||!kelas){ showToast('Data tidak lengkap','error'); return; }
  const maxNo=studentsByClass(kelas).reduce((m,s)=>Math.max(m,s.no_urut||0),0);
  const rows=namaList.map((nama,i)=>({
    nama, kelas, no_urut:maxNo+i+1, jk:'L', teacher_id:currentTeacher.id
  }));
  setSync('busy','Mengimport...');
  try{
    const {data,error}=await sb.from('students').insert(rows).select();
    if(error) throw error;
    students.push(...data);
    students.sort((a,b)=>a.kelas.localeCompare(b.kelas)||(a.no_urut-b.no_urut));
    setSync('','Tersinkron');
    showToast(`${data.length} siswa berhasil diimport ke kelas ${kelas}`);
    document.getElementById('importSiswaTeks').value='';
    document.getElementById('importPreview').innerHTML='';
    document.getElementById('importSiswaBtn').style.display='none';
    renderSiswaDaftarAdmin();
    renderDashboard();
  } catch(err){ setSync('err',''); showToast('Gagal: '+err.message,'error'); }
}


// ============================================================
// INIT
// ============================================================
window.addEventListener('DOMContentLoaded',()=>{
  initTheme();
  const saved=sessionStorage.getItem('jg_teacher');
  if(saved){
    try{
      currentTeacher=JSON.parse(saved);
      bootApp();
    } catch(e){ sessionStorage.removeItem('jg_teacher'); }
  }
  document.getElementById('loginPassword').addEventListener('keydown',e=>{ if(e.key==='Enter') doLogin(); });
  document.getElementById('loginUsername').addEventListener('keydown',e=>{ if(e.key==='Enter') doLogin(); });
});
