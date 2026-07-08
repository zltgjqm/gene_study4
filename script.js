import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

const SUPABASE_URL = "https://wtpsiyeccwzlulquahff.supabase.co";
const SUPABASE_KEY = "sb_publishable_XuB9o5EeAc6xf-QaJCUuHQ_kzAX9xlB";
const MARKER_TABLE = "marker_database";
const NOTES_TABLE = "user_notes";
const FAVORITES_TABLE = "user_favorites";
const PROFILES_TABLE = "profiles";
const PAGE_SIZE = 50;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const markerColumns = "gene_symbol,cell_type,species,disease,strength,db_source,evidence,tissue_or_organ";
const searchableColumns = ["gene_symbol", "cell_type", "disease", "tissue_or_organ", "species", "db_source", "evidence"];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

let libraryPage = 0;
let libraryFilters = {};
let currentSession = null;
let currentProfile = null;
let selectedFavoritesUserId = null;
let selectedFavoritesEmail = null;
// marker_key -> favorite row id (for delete)
let favoritesMap = new Map();

function buildMarkerKey(row) {
  return [row.gene_symbol, row.cell_type, row.disease, row.tissue_or_organ, row.species, row.db_source]
    .map((value) => (value === null || value === undefined ? "" : String(value).trim().toLowerCase()))
    .join("||");
}

function clean(value) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function maybe(value) {
  return value === null || value === undefined || value === "" || value === "-" ? null : String(value);
}

function escapeFilterValue(value) {
  return String(value).replaceAll("%", "\\%").replaceAll("_", "\\_").replaceAll(",", "\\,");
}


async function refreshAuthState() {
  const { data } = await supabase.auth.getSession();
  currentSession = data.session;
  currentProfile = await fetchMyProfile();
  selectedFavoritesUserId = null;
  selectedFavoritesEmail = null;
  renderAuthState();
  await loadFavorites();
  loadRecentNotes();
}

function isOwner() {
  return currentProfile?.role === "owner";
}

function isApprovedMember() {
  return Boolean(currentSession && currentProfile?.approved);
}

async function fetchMyProfile() {
  if (!currentSession) return null;
  const { data, error } = await supabase
    .from(PROFILES_TABLE)
    .select("user_id,email,role,approved,created_at")
    .eq("user_id", currentSession.user.id)
    .maybeSingle();
  if (error) {
    console.warn("profile fetch failed", error);
    return null;
  }
  return data;
}

function applyAccessGate() {
  const notice = $("#accessNotice");
  const locked = currentSession && !isApprovedMember();
  document.body.classList.toggle("app-locked", locked);
  notice.classList.toggle("hidden", !locked);

  if (!currentSession) {
    notice.innerHTML = "";
    return;
  }

  if (!currentProfile) {
    notice.innerHTML = `<h2>프로필을 확인할 수 없어.</h2><p class="hint">Supabase SQL 설정에서 profiles 테이블/trigger/RLS가 적용됐는지 확인해줘.</p>`;
    return;
  }

  if (!currentProfile.approved) {
    notice.innerHTML = `<h2>승인 대기 중</h2><p class="hint">${escapeHtml(currentSession.user.email)} 계정은 아직 owner 승인이 필요해. 승인 전에는 홈페이지를 사용할 수 없어.</p>`;
  } else {
    notice.innerHTML = "";
  }
}

function requireApprovedAccess() {
  if (!currentSession) {
    openAuthDialog();
    return false;
  }
  if (!isApprovedMember()) {
    setPage("home");
    return false;
  }
  return true;
}

async function loadFavorites() {
  favoritesMap = new Map();
  if (!currentSession || !isApprovedMember()) return;
  const { data, error } = await supabase.from(FAVORITES_TABLE).select("id, marker_key");
  if (error || !data) return;
  data.forEach((row) => favoritesMap.set(row.marker_key, row.id));
}

function isFavorited(row) {
  return favoritesMap.has(buildMarkerKey(row));
}

async function toggleFavorite(row, button) {
  if (!currentSession) {
    openAuthDialog();
    return;
  }
  const key = buildMarkerKey(row);
  const existingId = favoritesMap.get(key);
  button.disabled = true;
  try {
    if (existingId) {
      const { error } = await supabase.from(FAVORITES_TABLE).delete().eq("id", existingId);
      if (error) throw error;
      favoritesMap.delete(key);
      button.classList.remove("active");
    } else {
      const payload = {
        user_id: currentSession.user.id,
        marker_key: key,
        gene_symbol: maybe(row.gene_symbol),
        cell_type: maybe(row.cell_type),
        species: maybe(row.species),
        disease: maybe(row.disease),
        tissue_or_organ: maybe(row.tissue_or_organ),
        strength: maybe(row.strength),
        db_source: maybe(row.db_source),
        evidence: maybe(row.evidence)
      };
      const { data, error } = await supabase.from(FAVORITES_TABLE).insert(payload).select("id").single();
      if (error) throw error;
      favoritesMap.set(key, data.id);
      button.classList.add("active");
    }
  } catch (error) {
    alert(`즐겨찾기 처리 실패: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function loadFavoritesPage() {
  const container = $("#favoritesResults");
  const summary = $("#favoritesSummary");
  if (!requireApprovedAccess()) {
    container.innerHTML = `<div class="empty">승인된 member만 즐겨찾기를 볼 수 있어.</div>`;
    summary.textContent = "";
    return;
  }
  if (!currentSession) {
    container.innerHTML = `<div class="empty">로그인하면 즐겨찾기한 항목이 여기 모여.</div>`;
    summary.textContent = "";
    return;
  }
  summary.textContent = "불러오는 중...";
  container.innerHTML = "";
  let query = supabase.from(FAVORITES_TABLE).select("*").order("created_at", { ascending: false });
  if (isOwner() && selectedFavoritesUserId) query = query.eq("user_id", selectedFavoritesUserId);
  const { data, error } = await query;
  if (error) {
    container.innerHTML = `<div class="error">즐겨찾기 오류: ${error.message}</div>`;
    summary.textContent = "";
    return;
  }
  summary.textContent = data.length ? `${selectedFavoritesEmail ? `${selectedFavoritesEmail} · ` : ""}총 ${data.length}개` : (selectedFavoritesEmail ? `${selectedFavoritesEmail} · 즐겨찾기 없음` : "");
  renderMarkers(container, data || []);
}

function renderAuthState() {
  const email = currentSession?.user?.email;
  applyAccessGate();
  const profileLabel = currentProfile ? `${currentProfile.role}${currentProfile.approved ? "" : " · 미승인"}` : "profile 없음";
  $("#authEmail").textContent = email ? `로그인: ${email} (${profileLabel})` : "로그인 안 됨";
  $("#authOpenButton").classList.toggle("hidden", Boolean(email));
  $("#logoutButton").classList.toggle("hidden", !email);
  $("#memberManageButton").classList.toggle("hidden", !isOwner());
  $("#loginRequiredNotice").classList.toggle("hidden", isApprovedMember());
  $("#noteForm").classList.toggle("disabled", !isApprovedMember());
  $("#noteForm").querySelectorAll("input, select, textarea, button").forEach((el) => {
    if (el.id !== "resetNoteButton") el.disabled = !isApprovedMember();
  });
  $$(".add-relation-note").forEach((button) => button.disabled = !isApprovedMember());
  $$(".star-btn").forEach((button) => button.disabled = !isApprovedMember());
}

function openAuthDialog() {
  $("#authStatus").textContent = "";
  $("#authDialog").showModal();
}

async function login() {
  const status = $("#authStatus");
  status.className = "status";
  status.textContent = "로그인 중...";
  const { data, error } = await supabase.auth.signInWithPassword({
    email: $("#authEmailInput").value.trim(),
    password: $("#authPasswordInput").value
  });
  if (error) {
    status.className = "status error";
    status.textContent = `로그인 실패: ${error.message}`;
    return;
  }
  currentSession = data.session;
  currentProfile = await fetchMyProfile();
  renderAuthState();
  await loadFavorites();
  $("#authDialog").close();
  loadHome();
}

async function signup() {
  const status = $("#authStatus");
  status.className = "status";
  status.textContent = "회원가입 중...";
  const { data, error } = await supabase.auth.signUp({
    email: $("#authEmailInput").value.trim(),
    password: $("#authPasswordInput").value
  });
  if (error) {
    status.className = "status error";
    status.textContent = `회원가입 실패: ${error.message}`;
    return;
  }
  if (data.session) {
    currentSession = data.session;
    currentProfile = await fetchMyProfile();
    renderAuthState();
    await loadFavorites();
    $("#authDialog").close();
    loadHome();
  } else {
    status.textContent = "가입 완료! 이메일 확인 설정이 켜져 있으면 메일 인증 후 로그인해줘.";
  }
}

async function logout() {
  await supabase.auth.signOut();
  currentSession = null;
  currentProfile = null;
  selectedFavoritesUserId = null;
  selectedFavoritesEmail = null;
  renderAuthState();
  await loadFavorites();
  loadHome();
}

function setPage(pageName) {
  if (["search", "library", "favorites", "add"].includes(pageName) && !requireApprovedAccess()) pageName = "home";
  $$(".page-section").forEach((section) => section.classList.remove("active"));
  $(`#${pageName}Page`).classList.add("active");
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.page === pageName));

  if (pageName === "home") loadHome();
  if (pageName === "library" && $("#libraryResults").children.length === 0) loadLibrary(true);
  if (pageName === "favorites") loadFavoritesPage();
}

function saveRecent(type, value) {
  if (!value || value === "-") return;
  const item = { type, value, viewedAt: new Date().toISOString() };
  const old = JSON.parse(localStorage.getItem("recentViewed") || "[]");
  const filtered = old.filter((x) => !(x.type === type && x.value === value));
  localStorage.setItem("recentViewed", JSON.stringify([item, ...filtered].slice(0, 12)));
}

function renderPill(container, label, onClick) {
  const button = document.createElement("button");
  button.className = "pill";
  button.textContent = label;
  button.addEventListener("click", onClick);
  container.appendChild(button);
}

function quickSearch(value, mode = "all") {
  if (!value || value === "-") return;
  $("#globalSearchInput").value = value;
  $("#globalSearchMode").value = mode;
  setPage("search");
  searchMarkers();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function searchMarkers() {
  if (!requireApprovedAccess()) return;
  const keyword = $("#globalSearchInput").value.trim();
  const mode = $("#globalSearchMode").value;
  const results = $("#searchResults");
  const summary = $("#searchSummary");

  results.innerHTML = "";
  if (!keyword) {
    summary.textContent = "검색어를 입력해줘.";
    return;
  }

  summary.textContent = "검색 중...";

  let query = supabase.from(MARKER_TABLE).select(markerColumns, { count: "exact" }).limit(80);
  const safeKeyword = escapeFilterValue(keyword);

  if (mode === "all") {
    query = query.or(searchableColumns.map((column) => `${column}.ilike.%${safeKeyword}%`).join(","));
  } else {
    query = query.ilike(mode, `%${safeKeyword}%`);
  }

  const { data, error, count } = await query;
  if (error) {
    summary.textContent = "";
    results.innerHTML = `<div class="error">Supabase 오류: ${error.message}</div>`;
    return;
  }

  summary.textContent = data.length ? `총 ${count.toLocaleString()}개 중 ${data.length}개 표시` : "검색 결과가 없어.";
  renderMarkers(results, data || []);
}

async function loadNotesForRow(row) {
  if (!isApprovedMember()) return [];
  const gene = maybe(row.gene_symbol);
  const cell = maybe(row.cell_type);
  const disease = maybe(row.disease);

  let query = supabase.from(NOTES_TABLE).select("*").order("created_at", { ascending: false }).limit(5);
  query = query.eq("note_type", "relation");
  if (gene) query = query.eq("gene_symbol", gene);
  if (cell) query = query.eq("cell_type", cell);
  if (disease) query = query.eq("disease", disease);

  const { data, error } = await query;
  if (error) return [];
  return data || [];
}

function renderMarkers(container, rows) {
  const template = $("#markerCardTemplate");
  if (!rows.length) {
    container.innerHTML = `<div class="empty">표시할 데이터가 없어.</div>`;
    return;
  }

  // 즐겨찾기한 항목을 위로 정렬 (같은 favorite 상태 안에서는 원래 순서 유지)
  const sortedRows = [...rows].sort((a, b) => (isFavorited(b) ? 1 : 0) - (isFavorited(a) ? 1 : 0));

  for (const row of sortedRows) {
    const card = template.content.cloneNode(true);
    const starButton = card.querySelector(".star-btn");
    const geneButton = card.querySelector(".gene");
    const cellButton = card.querySelector(".cell");
    const expandToggle = card.querySelector(".expand-toggle");
    const cardBody = card.querySelector(".card-body");
    const noteButton = card.querySelector(".add-relation-note");
    const attachedNotes = card.querySelector(".attached-notes");

    geneButton.textContent = `Gene: ${clean(row.gene_symbol)}`;
    cellButton.textContent = `Cell: ${clean(row.cell_type)}`;

    starButton.classList.toggle("active", isFavorited(row));
    starButton.disabled = !currentSession;
    starButton.addEventListener("click", () => toggleFavorite(row, starButton));

    expandToggle.addEventListener("click", () => {
      const expanded = !cardBody.classList.contains("hidden");
      cardBody.classList.toggle("hidden", expanded);
      expandToggle.textContent = expanded ? "자세히 ▾" : "접기 ▴";
      expandToggle.setAttribute("aria-expanded", String(!expanded));
    });

    geneButton.addEventListener("click", () => {
      saveRecent("Gene", row.gene_symbol);
      quickSearch(row.gene_symbol, "gene_symbol");
    });
    cellButton.addEventListener("click", () => {
      saveRecent("Cell", row.cell_type);
      quickSearch(row.cell_type, "cell_type");
    });

    card.querySelector(".species").textContent = clean(row.species);
    card.querySelector(".disease").textContent = clean(row.disease);
    card.querySelector(".tissue").textContent = clean(row.tissue_or_organ);
    card.querySelector(".strength").textContent = clean(row.strength);
    card.querySelector(".source").textContent = clean(row.db_source);
    card.querySelector(".evidence").textContent = clean(row.evidence);

    noteButton.addEventListener("click", () => {
      setPage("add");
      fillNoteFormFromRow(row);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    container.appendChild(card);

    loadNotesForRow(row).then((notes) => {
      if (!notes.length) return;
      attachedNotes.innerHTML = notes.map(noteToHtml).join("");
    });
  }
  renderAuthState();
}

function fillNoteFormFromRow(row) {
  $("#noteType").value = "relation";
  $("#noteGene").value = maybe(row.gene_symbol) || "";
  $("#noteCell").value = maybe(row.cell_type) || "";
  $("#noteDisease").value = maybe(row.disease) || "";
  $("#noteTissue").value = maybe(row.tissue_or_organ) || "";
  $("#notePaper").value = maybe(row.db_source) || "";
  $("#notePmid").value = maybe(row.evidence) || "";
  $("#noteMemo").focus();
}

function noteToHtml(note) {
  const titleParts = [note.gene_symbol, note.cell_type, note.disease].filter(Boolean);
  const title = titleParts.length ? titleParts.join(" · ") : note.note_type;
  const date = note.created_at ? new Date(note.created_at).toLocaleDateString("ko-KR") : "";
  const paper = [note.paper_title, note.pmid].filter(Boolean).join(" / ");
  return `
    <div class="note-mini">
      <div class="note-title">${escapeHtml(title)}</div>
      <div class="note-meta">${escapeHtml(date)}${paper ? ` · ${escapeHtml(paper)}` : ""}</div>
      <div>${escapeHtml(note.memo)}</div>
      ${currentSession ? `<button class="ghost tiny delete-note" data-note-id="${note.id}">삭제</button>` : ""}
    </div>`;
}

function escapeHtml(value) {
  return clean(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" }[char]));
}

async function loadHome() {
  if (currentSession && !isApprovedMember()) { applyAccessGate(); return; }
  renderRecentViewed();
  loadRecentNotes();
  loadTopSuggestions();
}

function renderRecentViewed() {
  const container = $("#recentViewed");
  container.innerHTML = "";
  const items = JSON.parse(localStorage.getItem("recentViewed") || "[]").slice(0, 6);
  if (!items.length) {
    container.innerHTML = `<div class="empty">아직 최근 본 항목이 없어. 검색을 시작하면 여기에 쌓여.</div>`;
    return;
  }
  items.forEach((item) => renderPill(container, `${item.type}: ${item.value}`, () => quickSearch(item.value, item.type === "Gene" ? "gene_symbol" : item.type === "Cell" ? "cell_type" : "all")));
}

async function loadRecentNotes() {
  const container = $("#recentNotes");
  container.innerHTML = `<div class="muted">불러오는 중...</div>`;
  const { data, error } = await supabase.from(NOTES_TABLE).select("*").order("created_at", { ascending: false }).limit(6);
  if (!currentSession) {
    container.innerHTML = `<div class="empty">로그인하면 내 최근 메모가 여기에 보여.</div>`;
    return;
  }
  if (error) {
    container.innerHTML = `<div class="empty">user_notes 테이블 또는 RLS 설정을 확인해줘. README의 SQL을 실행하면 돼.</div>`;
    return;
  }
  container.innerHTML = data.length ? data.map(noteToHtml).join("") : `<div class="empty">아직 추가한 메모가 없어.</div>`;
}

async function loadTopSuggestions() {
  if (!isApprovedMember()) return;
  const { data, error } = await supabase.from(MARKER_TABLE).select("gene_symbol,cell_type").limit(1000);
  if (error || !data) return;
  renderTopList("#topGenes", countTop(data.map((row) => row.gene_symbol)), "gene_symbol", "Gene");
  renderTopList("#topCells", countTop(data.map((row) => row.cell_type)), "cell_type", "Cell");
}

function countTop(values) {
  const count = new Map();
  values.filter(Boolean).forEach((value) => count.set(value, (count.get(value) || 0) + 1));
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
}

function renderTopList(selector, items, mode, label) {
  const container = $(selector);
  container.innerHTML = "";
  items.forEach(([value, count]) => renderPill(container, `${value} (${count})`, () => {
    saveRecent(label, value);
    quickSearch(value, mode);
  }));
}

async function saveNote(event) {
  event.preventDefault();
  if (!requireApprovedAccess()) return;
  const status = $("#noteStatus");
  status.className = "status";
  status.textContent = "저장 중...";

  if (!currentSession) {
    status.className = "status error";
    status.textContent = "로그인 후 메모를 저장할 수 있어.";
    openAuthDialog();
    return;
  }

  const payload = {
    user_id: currentSession.user.id,
    note_type: $("#noteType").value,
    gene_symbol: maybe($("#noteGene").value),
    cell_type: maybe($("#noteCell").value),
    disease: maybe($("#noteDisease").value),
    tissue_or_organ: maybe($("#noteTissue").value),
    paper_title: maybe($("#notePaper").value),
    pmid: maybe($("#notePmid").value),
    tags: maybe($("#noteTags").value),
    memo: $("#noteMemo").value.trim()
  };

  if (!payload.memo) {
    status.className = "status error";
    status.textContent = "Memo는 꼭 적어줘.";
    return;
  }

  const { error } = await supabase.from(NOTES_TABLE).insert(payload);
  if (error) {
    status.className = "status error";
    status.textContent = `저장 실패: ${error.message}`;
    return;
  }

  status.textContent = "저장 완료! Home의 최근 추가한 메모에 바로 반영돼.";
  $("#noteForm").reset();
  loadRecentNotes();
}

async function loadLibrary(reset = false) {
  if (!requireApprovedAccess()) return;
  if (reset) {
    libraryPage = 0;
    $("#libraryResults").innerHTML = "";
  }

  const from = libraryPage * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;
  let query = supabase.from(MARKER_TABLE).select(markerColumns, { count: "exact" }).range(from, to);

  Object.entries(libraryFilters).forEach(([key, value]) => {
    if (value) query = query.ilike(key, `%${escapeFilterValue(value)}%`);
  });

  const { data, error, count } = await query;
  if (error) {
    $("#libraryResults").innerHTML = `<div class="error">Library 오류: ${error.message}</div>`;
    return;
  }

  $("#librarySummary").textContent = `총 ${count.toLocaleString()}개 · ${Math.min((libraryPage + 1) * PAGE_SIZE, count).toLocaleString()}개 표시 중`;
  renderMarkers($("#libraryResults"), data || []);
  libraryPage += 1;
  $("#loadMoreButton").style.display = from + (data?.length || 0) >= count ? "none" : "block";
}

function applyLibraryFilters() {
  libraryFilters = {
    gene_symbol: $("#libraryGene").value.trim(),
    cell_type: $("#libraryCell").value.trim(),
    disease: $("#libraryDisease").value.trim(),
    tissue_or_organ: $("#libraryTissue").value.trim()
  };
  loadLibrary(true);
}

function resetNoteForm() {
  $("#noteForm").reset();
  $("#noteStatus").textContent = "";
}


async function deleteNote(noteId) {
  if (!currentSession || !noteId) return;
  const ok = confirm("이 메모를 삭제할까?");
  if (!ok) return;
  const { error } = await supabase.from(NOTES_TABLE).delete().eq("id", noteId);
  if (error) {
    alert(`삭제 실패: ${error.message}`);
    return;
  }
  loadHome();
  if ($("#searchPage").classList.contains("active")) searchMarkers();
  if ($("#libraryPage").classList.contains("active")) loadLibrary(true);
}

async function loadMembers() {
  if (!isOwner()) return;
  const status = $("#memberStatus");
  const list = $("#memberList");
  status.className = "status";
  status.textContent = "불러오는 중...";
  list.innerHTML = "";

  const { data, error } = await supabase
    .from(PROFILES_TABLE)
    .select("user_id,email,role,approved,created_at")
    .order("created_at", { ascending: false });

  if (error) {
    status.className = "status error";
    status.textContent = `Member 목록 오류: ${error.message}`;
    return;
  }

  status.textContent = data.length ? `총 ${data.length}명` : "아직 가입한 member가 없어.";
  list.innerHTML = data.map(memberToHtml).join("");
}

function memberToHtml(member) {
  const isMe = member.user_id === currentSession?.user?.id;
  const approvedLabel = member.approved ? "승인됨" : "미승인";
  const approveButton = member.approved
    ? `<button class="secondary member-action" data-action="unapprove" data-user-id="${member.user_id}">승인 해제</button>`
    : `<button class="member-action" data-action="approve" data-user-id="${member.user_id}">승인</button>`;
  const roleButton = member.role === "owner"
    ? `<button class="secondary member-action" data-action="make-member" data-user-id="${member.user_id}" ${isMe ? "disabled" : ""}>member로 변경</button>`
    : `<button class="secondary member-action" data-action="make-owner" data-user-id="${member.user_id}">owner로 변경</button>`;

  return `
    <div class="member-row">
      <div class="member-meta">
        <div class="member-email">${escapeHtml(member.email || member.user_id)}</div>
        <div><span class="role-badge">${escapeHtml(member.role)} · ${approvedLabel}</span></div>
      </div>
      <div class="member-actions">
        ${approveButton}
        ${roleButton}
        <button class="ghost member-action" data-action="view-favorites" data-user-id="${member.user_id}" data-email="${escapeHtml(member.email || "")}">즐겨찾기 보기</button>
      </div>
    </div>`;
}

async function updateMember(userId, changes) {
  if (!isOwner()) return;
  const status = $("#memberStatus");
  status.className = "status";
  status.textContent = "저장 중...";
  const { error } = await supabase.from(PROFILES_TABLE).update(changes).eq("user_id", userId);
  if (error) {
    status.className = "status error";
    status.textContent = `저장 실패: ${error.message}`;
    return;
  }
  await loadMembers();
}

function bindEvents() {
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => setPage(tab.dataset.page)));
  $$('[data-page-jump]').forEach((button) => button.addEventListener("click", () => setPage(button.dataset.pageJump)));
  $("#memberManageButton").addEventListener("click", () => { $("#memberDialog").showModal(); loadMembers(); });
  $("#globalSearchButton").addEventListener("click", () => { setPage("search"); searchMarkers(); });
  $("#globalSearchInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { setPage("search"); searchMarkers(); }
  });
  $("#noteForm").addEventListener("submit", saveNote);
  $("#resetNoteButton").addEventListener("click", resetNoteForm);
  $("#libraryFilterButton").addEventListener("click", applyLibraryFilters);
  $("#libraryResetButton").addEventListener("click", () => {
    ["#libraryGene", "#libraryCell", "#libraryDisease", "#libraryTissue"].forEach((id) => $(id).value = "");
    libraryFilters = {};
    loadLibrary(true);
  });
  $("#loadMoreButton").addEventListener("click", () => loadLibrary(false));
  $("#clearRecentButton").addEventListener("click", () => {
    localStorage.removeItem("recentViewed");
    renderRecentViewed();
  });
  // 메모 삭제 버튼은 innerHTML로 동적 생성되므로 이벤트 위임으로 처리
  document.addEventListener("click", (event) => {
    const deleteButton = event.target.closest(".delete-note");
    if (deleteButton) deleteNote(deleteButton.dataset.noteId);

    const memberButton = event.target.closest(".member-action");
    if (memberButton) {
      const userId = memberButton.dataset.userId;
      if (memberButton.dataset.action === "approve") updateMember(userId, { approved: true });
      if (memberButton.dataset.action === "unapprove") updateMember(userId, { approved: false });
      if (memberButton.dataset.action === "make-owner") updateMember(userId, { role: "owner", approved: true });
      if (memberButton.dataset.action === "make-member") updateMember(userId, { role: "member" });
      if (memberButton.dataset.action === "view-favorites") {
        selectedFavoritesUserId = userId;
        selectedFavoritesEmail = memberButton.dataset.email || "선택한 member";
        $("#memberDialog").close();
        setPage("favorites");
        loadFavoritesPage();
      }
    }
  });
}

bindEvents();
refreshAuthState();
loadHome();
