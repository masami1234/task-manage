(function () {
  'use strict';

  const STORAGE_TASKS = 'mother_prompt_tasks';
  const STORAGE_MEMORY = 'mother_prompt_memory';
  const STORAGE_LAST_EDITED = 'mother_prompt_memory_edited';
  const STORAGE_COST = 'mother_prompt_api_cost';
  const STORAGE_COST_MONTH = 'mother_prompt_api_cost_month';
  const STORAGE_API_KEY = 'mother_prompt_gemini_key';
  const STORAGE_MOTHER_IMAGE = 'mother_prompt_mother_image';
  const DONE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

  const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

  let tasks = [];
  let currentTaskId = null;
  let ttsEnabled = false;
  let selectedVoice = null;
  let speechSynth = null;
  let costThisMonth = 0;
  let costMonthKey = '';

  const $ = (id) => document.getElementById(id);
  const taskListTodayEl = () => document.getElementById('task-list-today');
  const taskListTomorrowEl = () => document.getElementById('task-list-tomorrow');
  const taskListWeekEl = () => document.getElementById('task-list-week');
  const taskListDoneEl = () => document.getElementById('task-list-done');
  const currentTaskTitle = () => document.getElementById('current-task-title');
  const currentTaskMessage = () => document.getElementById('current-task-message');
  const btnDone = () => document.getElementById('btn-done');
  const adviceListEl = () => document.getElementById('events-list');
  const adviceTextEl = () => document.getElementById('advice-text');
  const motherIconEl = () => document.getElementById('mother-icon');
  const motherToastEl = () => document.getElementById('mother-toast');

  let currentExpression = 'neutral';
  let draggingTaskId = null;
  let currentDetailTaskId = null;

  function getApiKey() {
    return window.GEMINI_API_KEY || localStorage.getItem('GEMINI_API_KEY') || localStorage.getItem(STORAGE_API_KEY) || '';
  }

  function setMotherExpression(expr) {
    const icon = motherIconEl();
    if (!icon) return;
    icon.classList.remove('expression-neutral', 'expression-smile', 'expression-wink');
    if (expr === 'smile') icon.classList.add('expression-smile');
    else if (expr === 'wink') icon.classList.add('expression-wink');
    else icon.classList.add('expression-neutral');
    currentExpression = expr;
  }

  function applyCustomMotherImage() {
    const icon = motherIconEl();
    if (!icon) return;
    const dataUrl = localStorage.getItem(STORAGE_MOTHER_IMAGE);
    if (dataUrl) {
      icon.style.backgroundImage = `url(${dataUrl})`;
    }
  }

  function loadTasks() {
    try {
      const raw = localStorage.getItem(STORAGE_TASKS);
      tasks = raw ? JSON.parse(raw) : [
        { id: '1', text: 'お水を飲む', priority: 1, order: 0, status: 'active', bucket: 'today' },
        { id: '2', text: '窓をあけて換気', priority: 2, order: 1, status: 'active', bucket: 'today' },
        { id: '3', text: '今日の予定をひとつやる', priority: 3, order: 2, status: 'active', bucket: 'today' }
      ];
    } catch (_) {
      tasks = [];
    }
    // 完了から3日経過したタスクを自動削除
    const now = Date.now();
    tasks = tasks.filter(t => {
      if (t.status !== 'done') return true;
      if (!t.completedAt) return true;
      return now - t.completedAt <= DONE_TTL_MS;
    });
    ensureIds();
    renderTaskList();
  }

  function ensureIds() {
    tasks.forEach((t, i) => {
      if (!t.id) t.id = 't' + Date.now() + '_' + i;
      if (t.order === undefined) t.order = i;
      if (t.priority === undefined) t.priority = i + 1;
      if (!t.status) t.status = 'active';
      if (!t.bucket) t.bucket = 'today';
    });
  }

  function saveTasks() {
    localStorage.setItem(STORAGE_TASKS, JSON.stringify(tasks));
  }

  function addCostEstimate(yen) {
    const now = new Date();
    const key = now.getFullYear() + '-' + (now.getMonth() + 1);
    if (key !== costMonthKey) {
      costMonthKey = key;
      costThisMonth = 0;
    }
    const stored = localStorage.getItem(STORAGE_COST_MONTH);
    if (stored === key) {
      costThisMonth = parseFloat(localStorage.getItem(STORAGE_COST) || '0') || 0;
    } else {
      costThisMonth = 0;
    }
    costThisMonth += yen;
    localStorage.setItem(STORAGE_COST_MONTH, key);
    localStorage.setItem(STORAGE_COST, String(costThisMonth));
    updateCostIndicator();
  }

  function updateCostIndicator() {
    const key = new Date().getFullYear() + '-' + (new Date().getMonth() + 1);
    const storedMonth = localStorage.getItem(STORAGE_COST_MONTH);
    if (storedMonth === key) {
      costThisMonth = parseFloat(localStorage.getItem(STORAGE_COST) || '0') || 0;
    } else {
      costThisMonth = 0;
    }
    costMonthKey = key;
    const el = $('cost-value');
    if (el) el.textContent = '¥' + Math.round(costThisMonth);
  }

  async function optimizeWithGemini() {
    const apiKey = getApiKey();
    if (!apiKey) {
      alert('Gemini APIキーが未設定です。コード内の GEMINI_API_KEY または localStorage の GEMINI_API_KEY を設定してください。');
      return;
    }
    const active = tasks.filter(t => t.status !== 'done');
    const list = active.map(t => t.text).join('\n');
    const prompt = `以下は今日のやること一覧です。重要度・緊急度を考慮して1から${active.length}まで優先順位の数字だけを改行区切りで返してください。説明は不要です。\n\n${list}`;
    try {
      const res = await fetch(GEMINI_API_URL + '?key=' + apiKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 256, temperature: 0.2 }
        })
      });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const numbers = text.trim().split(/\s+/).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
      if (numbers.length >= active.length) {
        active.forEach((t, i) => {
          t.priority = numbers[i] != null ? numbers[i] : i + 1;
        });
        tasks.sort((a, b) => a.priority - b.priority);
        tasks.forEach((t, i) => { t.order = i; });
        saveTasks();
        renderTaskList();
      }
      addCostEstimate(0.02);
    } catch (e) {
      console.error(e);
      alert('優先度の最適化に失敗しました: ' + e.message);
    }
  }

  async function fetchAdviceWithGemini() {
    const apiKey = getApiKey();
    if (!apiKey) {
      alert('Gemini APIキーが未設定です。メモリー画面か localStorage に設定してください。');
      return;
    }
    const memory = localStorage.getItem(STORAGE_MEMORY) || '';
    const now = new Date();
    const month = now.getMonth() + 1;
    const taskLines = tasks.length
      ? tasks.map(t => `- ${t.text}`).join('\\n')
      : '（まだ登録されていません）';
    const prompt =
      'あなたは、日本のやさしいお母さんです。' +
      '以下の「やること一覧」と「メモリー」の内容を読み、' +
      '今日すべきタスク候補と、母親目線のひと言アドバイス、季節行事の提案をちょうど4行、日本語で出してください。' +
      '毎回少し違う候補や言い回しになるようにしてください。' +
      `現在の月は${month}月です。` +
      '\\n\\n【やること一覧】\\n' + taskLines +
      '\\n\\n【メモリー】\\n' + memory +
      '\\n\\n各行は「- タスク候補: アドバイス（季節のひと言）」の形式で、説明文以外は出力しないでください。';
    try {
      const res = await fetch(GEMINI_API_URL + '?key=' + apiKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 512, temperature: 0.6 }
        })
      });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const lines = text.split(/\\n+/).map(s => s.trim()).filter(Boolean).slice(0, 4);
      if (lines.length) renderAdviceItemsFromTexts(lines);
      addCostEstimate(0.04);
    } catch (e) {
      console.error(e);
      alert('助言の取得に失敗しました: ' + e.message);
    }
  }

  function renderTaskList() {
    const listToday = taskListTodayEl();
    const listTomorrow = taskListTomorrowEl();
    const listWeek = taskListWeekEl();
    const listDone = taskListDoneEl();
    if (!listToday || !listTomorrow || !listWeek || !listDone) return;

    const active = tasks.filter(t => t.status !== 'done');
    const completed = tasks.filter(t => t.status === 'done');

    function sorters(list) {
      return [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }

    const filtered = active;
    const buckets = { today: [], tomorrow: [], week: [] };
    filtered.forEach(t => {
      const b = t.bucket || 'today';
      if (!buckets[b]) buckets[b] = [];
      buckets[b].push(t);
    });

    function renderList(el, items, isDone) {
      const arr = sorters(items);
      el.innerHTML = arr.map(t => `
        <li data-id="${t.id}" class="${t.id === currentTaskId ? 'active' : ''}">
          <div class="task-main-row">
            <span class="task-title">${escapeHtml(t.text)}</span>
            ${t.priority != null ? `<span class="priority-badge">優先${t.priority}</span>` : ''}
            <button type="button" class="task-detail-btn" data-id="${t.id}" title="全文を見る">…</button>
            <button type="button" class="task-delete-btn" data-id="${t.id}" title="削除">×</button>
          </div>
        </li>
      `).join('');
      el.querySelectorAll('li').forEach(li => {
        const id = li.dataset.id;
        if (!isDone) {
          li.setAttribute('draggable', 'true');
          li.addEventListener('dragstart', (e) => {
            draggingTaskId = id;
            if (e.dataTransfer) e.dataTransfer.setData('text/plain', id);
          });
          li.addEventListener('dragover', (e) => {
            e.preventDefault();
            li.classList.add('drag-over');
          });
          li.addEventListener('dragleave', () => {
            li.classList.remove('drag-over');
          });
          li.addEventListener('drop', (e) => {
            e.preventDefault();
            li.classList.remove('drag-over');
            const sourceId = draggingTaskId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
            if (!sourceId || sourceId === id) return;
            reorderTaskWithinLists(sourceId, id);
            saveTasks();
            renderTaskList();
          });
          li.addEventListener('click', (e) => {
            const target = e.target;
            if (target && target.closest && target.closest('.task-detail-btn')) return;
            selectTask(id);
          });
        }
      });
      el.querySelectorAll('.task-detail-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          const t = tasks.find(x => x.id === id);
          if (t) openTaskDetailModal(id);
        });
      });
      el.querySelectorAll('.task-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          deleteTask(id);
        });
      });
    }

    renderList(listToday, buckets.today, false);
    renderList(listTomorrow, buckets.tomorrow, false);
    renderList(listWeek, buckets.week, false);
    renderList(listDone, completed, true);
  }

  function addTaskFromAdvice(text) {
    const title = (text || '').trim();
    if (!title) return;
    const bucket = 'today';
    const id = 'a' + Date.now();
    tasks.push({ id, text: title, priority: tasks.length + 1, order: tasks.length, status: 'active', bucket });
    saveTasks();
    renderTaskList();
    selectTask(id);
  }

  function deleteTask(id) {
    tasks = tasks.filter(t => t.id !== id);
    saveTasks();
    if (currentTaskId === id) {
      currentTaskId = null;
      currentTaskTitle().textContent = 'タスクを選んでね';
      currentTaskMessage().textContent = '左の一覧から選ぶか、新しいやることを追加してね。';
      if (btnDone()) btnDone().style.display = 'none';
    }
    renderTaskList();
  }

  function reorderTaskWithinLists(sourceId, targetId) {
    const source = tasks.find(t => t.id === sourceId);
    const target = tasks.find(t => t.id === targetId);
    if (!source || !target) return;
    if (source.status === 'done' || target.status === 'done') return;

    const targetBucket = target.bucket || 'today';
    source.bucket = targetBucket;

    const buckets = {
      today: [],
      tomorrow: [],
      week: []
    };

    tasks.forEach(t => {
      if (t.status === 'done') return;
      const b = t.bucket || 'today';
      if (!buckets[b]) buckets[b] = [];
      buckets[b].push(t);
    });

    const list = (buckets[targetBucket] || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const fromIndex = list.findIndex(t => t.id === sourceId);
    const toIndex = list.findIndex(t => t.id === targetId);
    if (fromIndex === -1 || toIndex === -1) return;
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    list.forEach((t, i) => { t.order = i; });
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function selectTask(id) {
    currentTaskId = id;
    const t = tasks.find(x => x.id === id);
    renderTaskList();
    if (t) {
      currentTaskTitle().textContent = t.text;
      currentTaskMessage().textContent = 'ひとつずつ、ていねいにやってみてね。できたら「できた！」を押してね。';
      if (btnDone()) {
        btnDone().style.display = 'block';
        btnDone().onclick = () => markDone(id);
      }
      if (ttsEnabled && selectedVoice) speak(t.text);
    } else {
      currentTaskTitle().textContent = 'タスクを選んでね';
      currentTaskMessage().textContent = '左の一覧から選ぶか、新しいやることを追加してね。';
      if (btnDone()) btnDone().style.display = 'none';
    }
  }

  function markDone(id) {
    const t = tasks.find(task => task.id === id);
    if (t) {
      t.status = 'done';
      t.completedAt = Date.now();
    }
    saveTasks();
    currentTaskId = null;
    renderTaskList();
    currentTaskTitle().textContent = 'タスクを選んでね';
    currentTaskMessage().textContent = 'よくできたね！ つぎは左から選んでね。';
    if (btnDone()) btnDone().style.display = 'none';
  }

  function addTask() {
    const input = $('new-task-input');
    const text = (input && input.value || '').trim();
    if (!text) return;
    const bucketSelect = $('new-task-bucket');
    const bucket = bucketSelect && bucketSelect.value ? bucketSelect.value : 'today';
    const id = 't' + Date.now();
    tasks.push({ id, text, priority: tasks.length + 1, order: tasks.length, status: 'active', bucket });
    saveTasks();
    if (input) input.value = '';
    renderTaskList();
    selectTask(id);
  }

  function initTTS() {
    speechSynth = window.speechSynthesis;
    const select = $('voice-select');
    if (!select) return;
    function fillVoices() {
      const voices = speechSynth.getVoices();
      const female = voices.filter(v => v.name && (v.name.includes('Female') || v.lang.startsWith('ja')));
      const list = female.length ? female : voices;
      select.innerHTML = '<option value="">選択...</option>' + list.map(v =>
        `<option value="${v.name}" data-lang="${v.lang}">${v.name} (${v.lang})</option>`
      ).join('');
    }
    fillVoices();
    if (speechSynth.getVoices().length) fillVoices();
    else speechSynth.onvoiceschanged = fillVoices;

    const toggle = $('tts-toggle');
    if (toggle) toggle.addEventListener('change', () => { ttsEnabled = toggle.checked; });
    select.addEventListener('change', () => {
      selectedVoice = select.selectedOptions[0] ? select.selectedOptions[0].value : null;
    });
  }

  function speak(text) {
    if (!speechSynth || !text) return;
    const plain = String(text).replace(/\s+/g, ' ').trim();
    if (!plain) return;
    speechSynth.cancel();
    const u = new SpeechSynthesisUtterance(plain);
    u.lang = 'ja-JP';
    if (selectedVoice) {
      const voices = speechSynth.getVoices();
      const v = voices.find(x => x.name === selectedVoice);
      if (v) u.voice = v;
    }
    speechSynth.speak(u);
  }

  function requestNotificationPermission() {
    const btn = $('btn-notify');
    if (!('Notification' in window)) {
      if (btn) btn.textContent = '通知は使えません';
      return;
    }
    if (Notification.permission === 'granted') {
      if (btn) { btn.textContent = '通知はオンです'; btn.classList.add('granted'); }
      return;
    }
    Notification.requestPermission().then(p => {
      if (p === 'granted' && btn) {
        btn.textContent = '通知はオンです';
        btn.classList.add('granted');
      } else if (btn) btn.textContent = '通知をオンにする';
    });
  }

  function initMemory() {
    const overlay = $('memory-overlay');
    const openBtn = $('btn-memory-entry');
    const closeBtn = $('btn-memory-close');
    const textarea = $('memory-text');
    const rescanBtn = $('btn-rescan');
    const autosaveMsg = $('memory-autosave-msg');
    const lastEditedEl = $('memory-last-edited');
    const apiKeyInput = $('memory-api-key-input');

    function loadMemory() {
      textarea.value = localStorage.getItem(STORAGE_MEMORY) || '';
      const edited = localStorage.getItem(STORAGE_LAST_EDITED);
      if (lastEditedEl) lastEditedEl.textContent = edited ? '最終編集: ' + edited : '最終編集: --';
      if (apiKeyInput) apiKeyInput.value = localStorage.getItem(STORAGE_API_KEY) || localStorage.getItem('GEMINI_API_KEY') || '';
    }

    function saveMemory() {
      const v = textarea.value;
      localStorage.setItem(STORAGE_MEMORY, v);
      const keyVal = apiKeyInput ? apiKeyInput.value.trim() : '';
      if (keyVal) localStorage.setItem(STORAGE_API_KEY, keyVal);
      const now = new Date().toLocaleString('ja-JP');
      localStorage.setItem(STORAGE_LAST_EDITED, now);
      if (lastEditedEl) lastEditedEl.textContent = '最終編集: ' + now;
      if (autosaveMsg) { autosaveMsg.textContent = '自動保存しました ' + now; setTimeout(() => { autosaveMsg.textContent = ''; }, 2000); }
    }

    let saveTimer = null;
    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveMemory, 800);
    }

    if (openBtn) openBtn.addEventListener('click', () => {
      loadMemory();
      if (overlay) overlay.hidden = false;
    });
    if (closeBtn) closeBtn.addEventListener('click', () => { if (overlay) overlay.hidden = true; });
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.hidden = true; });
    if (textarea) {
      textarea.addEventListener('input', scheduleSave);
      textarea.addEventListener('blur', saveMemory);
    }
    if (apiKeyInput) apiKeyInput.addEventListener('blur', saveMemory);
    if (rescanBtn) rescanBtn.addEventListener('click', () => {
      saveMemory();
      loadMemory();
      if (autosaveMsg) autosaveMsg.textContent = '再スキャン（再読み込み）しました。';
      setTimeout(() => { if (autosaveMsg) autosaveMsg.textContent = ''; }, 2000);
    });
    loadMemory();
  }

  function openTaskDetailModal(id) {
    const overlay = $('task-detail-overlay');
    const body = $('task-detail-text');
    const restoreBtn = $('task-detail-restore');
    if (!overlay || !body) return;
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    currentDetailTaskId = id;
    body.textContent = t.text || '';
    if (restoreBtn) {
      restoreBtn.style.display = t.status === 'done' ? 'inline-flex' : 'none';
    }
    overlay.hidden = false;
  }

  function closeTaskDetailModal() {
    const overlay = $('task-detail-overlay');
    if (!overlay) return;
    overlay.hidden = true;
  }

  function renderAdviceItemsFromTexts(texts) {
    const list = adviceListEl();
    if (!list) return;
    const items = texts.map(raw => {
      const line = raw.trim();
      if (!line) return null;
      const noBullet = line.replace(/^[-・\\s]*/, '');
      const taskTitle = noBullet.split(/[：:]/)[0].trim() || noBullet;
      return { line: noBullet, taskTitle };
    }).filter(Boolean);
    const limited = items.slice(0, 4);
    list.innerHTML = limited.map(item => `
      <li draggable="true" data-task="${escapeHtml(item.taskTitle)}">
        ${escapeHtml(item.line)}
      </li>
    `).join('');
    list.querySelectorAll('li').forEach(li => {
      li.addEventListener('click', () => {
        const title = li.dataset.task || li.textContent.trim();
        addTaskFromAdvice(title);
      });
      li.addEventListener('dragstart', (e) => {
        const title = li.dataset.task || li.textContent.trim();
        if (e.dataTransfer) e.dataTransfer.setData('text/plain', title);
      });
    });
    if (limited.length) {
      const first = limited[0];
      const caption = adviceTextEl();
      if (caption) caption.textContent = first.line;
    }
  }

  function initEvents() {
    const now = new Date();
    const month = now.getMonth() + 1;
    const events = [
      { m: 2, text: '年度末の提出物チェック' },
      { m: 3, text: '新年度の準備・スケジュール確認' },
      { m: 4, text: '新学期のリズムに慣れるまで無理しない' },
      { m: 5, text: '連休前後の予定の見直し' },
      { m: 6, text: '梅雨の時期は室内でできることを優先' },
      { m: 7, text: '夏の暑さ対策・水分補給を忘れずに' },
      { m: 8, text: 'お盆の予定の確認' },
      { m: 9, text: '秋の行事カレンダーを確認' },
      { m: 10, text: '衣替えと過ごし方の見直し' },
      { m: 11, text: '年末に向けたやることリスト' },
      { m: 12, text: '年末の締め・新年の準備' },
      { m: 1, text: '新年の目標は「ひとつずつ」で' }
    ];
    const idx = month - 1;
    const suggestions = [];
    for (let i = 0; i < 4; i++) {
      const e = events[(idx + i) % events.length];
      suggestions.push(e.text);
    }
    renderAdviceItemsFromTexts(suggestions);
  }

  function init() {
    loadTasks();
    updateCostIndicator();
    initTTS();
    initEvents();
    initMemory();

    const btnOptimize = $('btn-optimize');
    if (btnOptimize) btnOptimize.addEventListener('click', optimizeWithGemini);
    const btnAdd = $('btn-add-task');
    if (btnAdd) btnAdd.addEventListener('click', addTask);
    const newInput = $('new-task-input');
    if (newInput) newInput.addEventListener('keydown', e => { if (e.key === 'Enter') addTask(); });

    // 助言パネル: Gemini から候補を取得
    const btnAdvice = $('btn-advice-refresh');
    if (btnAdvice) btnAdvice.addEventListener('click', fetchAdviceWithGemini);

    // 中央ペインをD&Dのドロップターゲットに
    const current = $('current-task');
    if (current) {
      current.addEventListener('dragover', (e) => {
        e.preventDefault();
        current.classList.add('drop-active');
      });
      current.addEventListener('dragleave', () => {
        current.classList.remove('drop-active');
      });
      current.addEventListener('drop', (e) => {
        e.preventDefault();
        current.classList.remove('drop-active');
        const title = e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
        if (title) addTaskFromAdvice(title);
      });
    }

    // 母親アイコンのアニメーション（呼吸・まばたき）
    const icon = motherIconEl();
    if (icon) {
      icon.classList.add('breathing');
      setMotherExpression('neutral');
    }

    // タスク詳細モーダル
    const taskDetailOverlay = $('task-detail-overlay');
    const taskDetailClose = $('task-detail-close');
    const taskDetailRestore = $('task-detail-restore');
    if (taskDetailClose) taskDetailClose.addEventListener('click', closeTaskDetailModal);
    if (taskDetailOverlay) {
      taskDetailOverlay.addEventListener('click', (e) => {
        if (e.target === taskDetailOverlay) closeTaskDetailModal();
      });
    }
    if (taskDetailRestore) {
      taskDetailRestore.addEventListener('click', () => {
        if (!currentDetailTaskId) return;
        const t = tasks.find(x => x.id === currentDetailTaskId);
        if (!t) return;
        t.status = 'active';
        if (!t.bucket) t.bucket = 'today';
        saveTasks();
        renderTaskList();
        closeTaskDetailModal();
      });
    }

    // 下部ツールの表示/非表示トグル
    const bottomToggle = $('bottom-tools-toggle');
    if (bottomToggle) {
      bottomToggle.addEventListener('click', () => {
        const cost = $('cost-indicator');
        const qa = $('quick-add');
        const hidden = cost && cost.style.display === 'none';
        const nextHidden = !hidden;
        if (cost) cost.style.display = nextHidden ? 'none' : '';
        if (qa) qa.style.display = nextHidden ? 'none' : '';
        bottomToggle.textContent = nextHidden ? 'ツールを出す' : 'ツールをしまう';
      });
    }

    // 画像変更ボタン
    const imgBtn = $('btn-image-change');
    const imgInput = $('mother-image-input');
    if (imgBtn && imgInput) {
      imgBtn.addEventListener('click', () => imgInput.click());
      imgInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          if (typeof dataUrl === 'string') {
            localStorage.setItem(STORAGE_MOTHER_IMAGE, dataUrl);
            applyCustomMotherImage();
          }
        };
        reader.readAsDataURL(file);
      });
    }

    // 画像のカスタム反映
    applyCustomMotherImage();

    // まとめてタスク追加ウィンドウ
    const qaToggle = $('btn-quick-add-toggle');
    const qaBody = $('quick-add-body');
    const qaText = $('quick-add-text');
    const qaList = $('quick-add-list');
    const qaAll = $('btn-quick-add-all');

    function parseQuickLines() {
      if (!qaText || !qaList) return;
      const lines = qaText.value.split(/\n+/).map(s => s.trim()).filter(Boolean);
      qaList.innerHTML = lines.map(line => `
        <li draggable="true" data-task="${escapeHtml(line)}">${escapeHtml(line)}</li>
      `).join('');
      qaList.querySelectorAll('li').forEach(li => {
        li.addEventListener('click', () => addTaskFromAdvice(li.dataset.task || li.textContent.trim()));
        li.addEventListener('dragstart', (e) => {
          const title = li.dataset.task || li.textContent.trim();
          if (e.dataTransfer) e.dataTransfer.setData('text/plain', title);
        });
      });
    }

    if (qaToggle && qaBody) {
      qaToggle.addEventListener('click', () => {
        qaBody.hidden = !qaBody.hidden;
        if (!qaBody.hidden) parseQuickLines();
      });
    }
    if (qaText) {
      qaText.addEventListener('input', parseQuickLines);
    }
    if (qaAll) {
      qaAll.addEventListener('click', () => {
        if (!qaText) return;
        const lines = qaText.value.split(/\n+/).map(s => s.trim()).filter(Boolean);
        lines.forEach(line => addTaskFromAdvice(line));
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
