/* 프로젝트 나이트 — 휴대폰 테스트 배포본(GitHub Pages) 전용 서버 연결 (Firebase)
   게임 본문은 아티팩트의 window.claude.use("room" | "db" | "user") 를 쓰므로, 여기서 같은 모양의 함수를 Firebase로 만들어 끼운다.
   - 계정(v0.93): 게임 첫 화면에서 '게스트로 시작'(익명) 또는 'Google로 로그인'을 고름 — 한 번 로그인하면 다음부턴 자동 로그인 · 첫 화면에 로그아웃 단추
     게스트는 설정에서 Google 계정을 연결하면 다른 기기에서도 같은 진행
   - v0.93 테스트 운영: notices(공지) · mail(우편) · feedback(의견) · errors(오류) · players(플레이어별 진행 기록) · admins(관리자 uid)
   - room: 실시간 데이터베이스 rooms/<방 이름>/<접속자> 에 각자의 상태(presence)를 JSON 글자로 둠 · 창을 닫으면 자동으로 지워짐
   - db: data/users/<uid>/save → saves/<uid> (클라우드 저장)
   이 파일은 tools/deploy/build_play.js 가 배포본에 넣는다(아티팩트에는 들어가지 않음). */
(function () {
  if (window.claude && typeof window.claude.use === "function") return;   // 아티팩트 안에서는 원래 기능을 씀
  if (!window.firebase || !window.PN_FIREBASE) return;
  const fb = window.firebase;
  try { fb.initializeApp(window.PN_FIREBASE); } catch (e) { console.warn("[PNNet] init", e); return; }
  const auth = fb.auth(), rtdb = fb.database(), TS = fb.database.ServerValue.TIMESTAMP;
  const TAB = Math.random().toString(36).slice(2, 8);
  // v0.93 자동으로 손님 로그인하지 않음 — 첫 화면에서 고른 뒤에 ready가 풀림(게임은 첫 화면을 지나야 시작)
  let user = null, readyRes, authInitRes, authErr = null; const ready = new Promise(r => readyRes = r), authInit = new Promise(r => authInitRes = r);
  const authSubs = [];
  auth.onAuthStateChanged(u => { user = u || null; authInitRes(); if (u) readyRes(u); render(); for (const f of authSubs) try { f(user); } catch (e) {} });
  try { if (auth.getRedirectResult) auth.getRedirectResult().catch(e => { authErr = e; console.warn("[PNNet] redirect", e); }); } catch (e) {}
  setTimeout(() => authInitRes(), 8000);   // 서버가 안 닿으면 8초 뒤 첫 화면이 '오프라인으로 시작'을 보여 줌

  const safeKey = s => String(s).replace(/[.#$\[\]\/]/g, "_").slice(0, 64);
  // ---------- room ----------
  function makeRoom(name, me) {
    const ref = rtdb.ref("rooms/" + safeKey(name)), mine = ref.child(me);
    let state = {}, cache = {}, live = true; const handlers = [], offs = [];
    const snap = () => Object.entries(cache).map(([peer, v]) => {
      let presence = {}; try { presence = JSON.parse(v.j) || {}; } catch (e) {}
      return { peer, presence, isMe: v.u === user.uid, sameTab: peer === me, kind: "viewer", guest: false, by: null, updatedAt: v.at || 0 };
    });
    const fire = () => { const s = snap(); for (const h of handlers) try { h.fn({ peers: s, joined: [], left: [], updated: [] }); } catch (e) { console.warn(e); } };
    const onVal = s => { cache = s.val() || {}; fire(); };
    const onErr = e => { for (const h of handlers) if (h.err) try { h.err({ code: (e && e.code) || "unavailable", message: e && e.message }); } catch (x) {} };
    ref.on("value", onVal, onErr);
    mine.onDisconnect().remove();
    return {
      name,
      presence: async patch => { if (!live) return;
        state = Object.assign({}, state, patch || {}); for (const k of Object.keys(patch || {})) if (patch[k] === null || patch[k] === undefined) delete state[k];
        await mine.set({ u: user.uid, j: JSON.stringify(state), at: TS }); },
      peers: () => snap(),
      onPeers: (fn, err) => { const h = { fn, err }; handlers.push(h); setTimeout(() => { try { fn({ peers: snap(), joined: snap(), left: [], updated: [] }); } catch (e) {} }, 0);
        return () => { const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); }; },
      connected: () => conn,
      onConnection: f => { connSubs.push(f); setTimeout(() => f(conn), 0); return () => { const i = connSubs.indexOf(f); if (i >= 0) connSubs.splice(i, 1); }; },
      emit: async () => {}, on: () => () => {},
      leave: async () => { if (!live) return; live = false; ref.off("value", onVal); for (const o of offs) o();
        try { await mine.onDisconnect().cancel(); await mine.remove(); } catch (e) {} }
    };
  }
  let conn = false; const connSubs = [];
  rtdb.ref(".info/connected").on("value", s => { conn = !!s.val(); for (const f of connSubs) try { f(conn); } catch (e) {} });
  async function roomApi() {
    const u = await ready; if (!u) return null;
    const me = safeKey(u.uid + "_" + TAB);
    const lobby = makeRoom("lobby", me);
    lobby.join = async n => makeRoom(n, me);
    return lobby;
  }
  // ---------- db (클라우드 저장) ----------
  function docRef(path) {
    const m = /^data\/users\/([^/]+)\/save$/.exec(path); if (!m) throw { code: "invalid_argument", message: path };
    return rtdb.ref("saves/" + safeKey(m[1]));
  }
  const wrap = s => ({ exists: s.exists(), data: () => s.val(), metadata: { hasPendingWrites: false } });
  async function dbApi() {
    const u = await ready; if (!u) return null;
    return { doc: path => { const r = docRef(path); return {
      get: async () => wrap(await r.once("value")),
      set: async obj => { await r.set(JSON.parse(JSON.stringify(obj))); },
      onSnapshot: (fn, err) => { const cb = s => fn(wrap(s)); r.on("value", cb, e => err && err(e)); return () => r.off("value", cb); }
    }; } };
  }
  async function userApi() {
    const u = await ready; if (!u) return null;
    return { id: async () => u.uid, isOwner: () => false, canEdit: () => false, can: () => null, me: async () => ({ id: u.uid, name: u.displayName || "" }) };
  }
  window.claude = { use: async name => name === "room" ? roomApi() : name === "db" ? dbApi() : name === "user" ? userApi() : null };

  // ---------- 설정 화면의 '계정' 칸 ----------
  function esc(s) { return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function render() { const el = document.getElementById("pnAcct"); if (el) el.innerHTML = acctInner(); bind(el); }
  function acctInner() {
    if (!user) return `<p class="msub">서버에 연결하는 중… (연결이 안 되면 이 기기에만 저장되고 함께하기는 꺼집니다)</p>`;
    const idl = ` <span style="opacity:.75">(계정 ID ${esc(user.uid.slice(0, 6))}…)</span>`;
    if (user.isAnonymous) return `<p class="msub">지금은 <b>손님 계정</b>${idl}입니다 — 진행은 서버에 저장되지만 이 기기·이 브라우저에서만 이어집니다. Google 계정을 연결하면 다른 휴대폰·PC에서도 같은 진행으로 이어 할 수 있어요.</p>
      <div class="srow"><button class="btn" data-pn="google">Google 계정 연결</button></div>`;
    return `<p class="msub">Google 계정 <b>${esc(user.email || user.displayName)}</b>${idl}으로 로그인됨 — 어느 기기에서 열어도 같은 진행이 이어집니다.</p>
      <div class="srow"><button class="btn ghost" data-pn="out">로그아웃</button></div>`;
  }
  function bind(el) { if (!el) return;
    const g = el.querySelector('[data-pn="google"]'); if (g) g.onclick = google;
    const o = el.querySelector('[data-pn="out"]'); if (o) o.onclick = async () => { if (!confirmBox("로그아웃하면 이 기기는 새 손님 계정으로 처음부터 시작합니다(진행은 Google 계정에 남아 있음). 로그아웃할까요?")) return;
      try { localStorage.removeItem("pn_progress_v02"); localStorage.removeItem("pn_rules_v01"); } catch (e) {}
      await auth.signOut(); location.reload(); };
  }
  // v0.94 이 기기 진행을 지우는 모든 길(로그아웃 · 계정 바꾸기)에서 먼저 백업 — 설정 '이 기기의 이전 진행'에서 되살림
  function backupLocal(why) { try { const pg = localStorage.getItem("pn_progress_v02"), rl = localStorage.getItem("pn_rules_v01"); if (!pg) return;
    const P = JSON.parse(pg); if (!P || !P.heroes) return; localStorage.setItem("pn_local_backup", JSON.stringify({ progress: P, rules: rl ? JSON.parse(rl) : null, at: Date.now(), why, uid: (auth.currentUser && auth.currentUser.uid) || "", anon: !!(auth.currentUser && auth.currentUser.isAnonymous) })); } catch (e) {} }   // anon: 게스트 진행만 다른 계정으로 넘길 수 있음
  function confirmBox(t) { try { return window.confirm(t); } catch (e) { return true; } }
  async function google() {
    const prov = new fb.auth.GoogleAuthProvider(); prov.setCustomParameters({ prompt: "select_account" });
    try { await user.linkWithPopup(prov); await auth.currentUser.reload(); user = auth.currentUser; render(); try { if (typeof window.cloudFlush === "function") window.cloudFlush(); } catch (x) {} note("Google 계정을 연결했습니다 — 지금 진행이 이 Google 계정에 저장됐고, 다른 기기에서도 이 계정으로 들어오면 이어집니다."); }
    catch (e) {
      if (e && e.code === "auth/credential-already-in-use" && e.credential) {
        // 이 Google 계정은 이미 다른 기기에서 쓰던 계정 → 그 계정으로 들어가고, 그쪽 진행을 불러온다(이 기기 진행은 게임이 백업해 둠)
        try { backupLocal("switch"); localStorage.removeItem("pn_progress_v02"); localStorage.removeItem("pn_rules_v01"); } catch (x) {}
        await auth.signInWithCredential(e.credential); location.reload(); return; }
      if (e && (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request")) return;
      note("Google 연결에 실패했습니다: " + ((e && (e.code || e.message)) || e));
    }
  }
  function note(t) { try { if (typeof window.toast === "function") window.toast(esc(t)); else alert(t); } catch (e) {} }
  // ---------- v0.67 영웅 빌려 쓰기 ----------
  // lend/<uid> = 내가 빌려줄 영웅(누구나 읽음, 나만 씀) · credits/<빌려준 사람>/<번호> = 빌려 간 기록(남이 하나씩 추가, 주인만 읽고 지움)
  const lend = {
    publish: async entry => { const u = await ready; if (!u) return false; await rtdb.ref("lend/" + safeKey(u.uid)).set({ u: u.uid, j: JSON.stringify(entry), at: TS }); return true; },
    list: async () => { const u = await ready; if (!u) return [];
      const s = await rtdb.ref("lend").orderByChild("at").limitToLast(40).once("value"); const out = [];
      s.forEach(c => { const v = c.val(); if (!v || v.u === u.uid) return; try { const e = JSON.parse(v.j); e.uid = v.u; e.at = v.at || 0; out.push(e); } catch (x) {} });
      return out.sort((a, b) => b.at - a.at); },
    credit: async lender => { const u = await ready; if (!u || !lender || lender === u.uid) return; try { await rtdb.ref("credits/" + safeKey(lender)).push({ from: u.uid, at: TS }); } catch (e) { console.warn("[PNNet] credit", e); } },
    collect: async () => { const u = await ready; if (!u) return 0; const r = rtdb.ref("credits/" + safeKey(u.uid));
      const s = await r.once("value"); const n = s.exists() ? Object.keys(s.val() || {}).length : 0; if (n) await r.remove(); return n; }
  };
  // ---------- v0.93 첫 화면 로그인 ----------
  const authApi = {
    init: () => authInit,
    state: () => user ? { uid: user.uid, anon: !!user.isAnonymous, name: user.displayName || "", email: user.email || "" } : null,
    onChange: f => { authSubs.push(f); },
    lastError: () => authErr,
    guest: async () => { await auth.signInAnonymously(); return authApi.state(); },
    google: async () => { const prov = new fb.auth.GoogleAuthProvider(); prov.setCustomParameters({ prompt: "select_account" });
      try { await auth.signInWithPopup(prov); return authApi.state(); }
      catch (e) { if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) { await auth.signInWithRedirect(prov); return null; } throw e; } },
    logout: async () => { backupLocal("logout"); try { for (const k of ["pn_progress_v02", "pn_rules_v01", "pn_last_uid"]) localStorage.removeItem(k); } catch (e) {} await auth.signOut(); },
    // v0.94 게스트 → Google 계정 연결(같은 계정 ID 유지 · 지금 진행 그대로). 이미 쓰던 Google 계정이면 그 계정으로 들어가고 이 기기 진행은 백업
    linkGoogle: async () => { const u = auth.currentUser; const prov = new fb.auth.GoogleAuthProvider(); prov.setCustomParameters({ prompt: "select_account" });
      if (!u) { await auth.signInWithPopup(prov); return { switched: true }; }
      try { await u.linkWithPopup(prov); await auth.currentUser.reload(); user = auth.currentUser; render(); try { if (typeof window.cloudFlush === "function") window.cloudFlush(); } catch (x) {} return { linked: true }; }
      catch (e) { if (e && e.code === "auth/credential-already-in-use" && e.credential) { backupLocal("switch"); try { localStorage.removeItem("pn_progress_v02"); localStorage.removeItem("pn_rules_v01"); } catch (x) {} await auth.signInWithCredential(e.credential); return { switched: true }; } throw e; } },
    offline: () => readyRes(null)
  };
  // ---------- v0.93 테스트 운영(공지 · 우편 · 의견 · 오류 · 플레이어 기록) ----------
  const val = async path => { const s = await rtdb.ref(path).once("value"); return s.val(); };
  const list = o => Object.entries(o || {}).map(([id, v]) => { let x = Object.assign({ id }, v); if (typeof v.j === "string") { try { x = Object.assign(x, JSON.parse(v.j)); } catch (e) {} delete x.j; } return x; });
  const ops = {
    isAdmin: async () => { const u = await ready; if (!u) return false; try { return (await val("admins/" + u.uid)) === true; } catch (e) { return false; } },
    notices: async () => list(await val("notices")).sort((a, b) => (b.at || 0) - (a.at || 0)),
    noticeAdd: async o => { const u = await ready; await rtdb.ref("notices").push(Object.assign({}, o, { by: u.uid, at: TS })); },
    noticeEdit: async (id, o) => { await rtdb.ref("notices/" + safeKey(id)).update({ t: o.t, body: o.body, ed: TS }); },
    noticeDel: async id => { await rtdb.ref("notices/" + safeKey(id)).remove(); },
    mail: async () => { const u = await ready; if (!u) return [];
      const [a, m] = await Promise.all([val("mail/all").catch(() => null), val("mail/u/" + u.uid).catch(() => null)]);
      return list(a).concat(list(m).map(x => Object.assign(x, { mine: true }))).sort((x, y) => (y.at || 0) - (x.at || 0)); },
    mailWatch: async f => { const u = await ready; if (!u) return; const h = () => f();
      rtdb.ref("mail/all").on("value", h, () => {}); rtdb.ref("mail/u/" + u.uid).on("value", h, () => {}); },
    mailSend: async (to, o) => { const u = await ready; if (!u) throw new Error("로그인되어 있지 않음(서버 연결 없음)"); const ref = to === "all" ? rtdb.ref("mail/all") : rtdb.ref("mail/u/" + safeKey(to)); await ref.push(Object.assign({}, o, { by: u.uid, at: TS })); },
    mailList: async () => { const [a, u] = await Promise.all([val("mail/all"), val("mail/u")]); const out = list(a).map(x => Object.assign(x, { to: "all" }));
      for (const [uid, box] of Object.entries(u || {})) for (const x of list(box)) out.push(Object.assign(x, { to: uid })); return out.sort((x, y) => (y.at || 0) - (x.at || 0)); },
    mailDel: async (to, id) => { await rtdb.ref((to === "all" ? "mail/all/" : "mail/u/" + safeKey(to) + "/") + safeKey(id)).remove(); },
    feedback: async o => { const u = await ready; if (!u) throw new Error("로그인 안 됨"); await rtdb.ref("feedback").push({ j: JSON.stringify(o), u: u.uid, at: TS }); },
    error: async o => { const u = await ready; if (!u) return; await rtdb.ref("errors").push({ j: JSON.stringify(o), u: u.uid, at: TS }); },
    feedbackList: async () => list(await val("feedback")).sort((a, b) => (b.at || 0) - (a.at || 0)),
    errorList: async () => list(await val("errors")).sort((a, b) => (b.at || 0) - (a.at || 0)),
    del: async path => { if (!/^(feedback|errors)\/[\w-]+$/.test(path)) return; await rtdb.ref(path).remove(); },
    playerPut: async o => { const u = await ready; if (!u) return; await rtdb.ref("players/" + u.uid).set({ j: JSON.stringify(o), at: TS, anon: !!u.isAnonymous, gname: u.displayName || "" }); },
    players: async () => list(await val("players")).sort((a, b) => (b.at || 0) - (a.at || 0)),
    uid: () => user && user.uid,
    // v0.94 관리자: 서버 저장 목록(계정 ID · 저장 시각 · 요약 · 저장한 기기) · 한 계정의 진행을 다른 계정으로 복사(받는 쪽 원래 저장은 saveBackups에 보관)
    saves: async () => { const s = await rtdb.ref("saves").once("value"); const out = []; s.forEach(c => { const v = c.val() || {}; let sum = v.sum || ""; if (!sum) { try { const p = JSON.parse(v.save).progress; sum = (p.protag && p.protag.name ? "★" + p.protag.name + " · " : "") + "골드 " + (p.gold || 0); } catch (e) {} } out.push({ uid: c.key, savedAt: v.savedAt || 0, dev: v.dev || "", sum, size: (v.save || "").length }); }); return out.sort((a, b) => b.savedAt - a.savedAt); },
    saveCopy: async (from, to) => { const v = await val("saves/" + safeKey(from)); if (!v || typeof v.save !== "string") throw new Error("옮길 저장이 없습니다: " + from);
      const cur = await val("saves/" + safeKey(to)); if (cur && typeof cur.save === "string") await rtdb.ref("saveBackups/" + safeKey(to) + "/" + Date.now()).set(cur);
      await rtdb.ref("saves/" + safeKey(to)).set(Object.assign({}, v, { savedAt: Date.now(), movedFrom: from })); await rtdb.ref("invited/" + safeKey(to)).set({ by: "admin", at: TS }).catch(() => {}); return true; }
  };
  // ---------- v0.94 비공개 테스트 초대 코드 ----------
  // config/inviteOnly=true 일 때만 막음 · invites/<코드>={at, used:uid} · invited/<uid>={code|g, at}
  // 통과: 관리자 · 코드를 쓴 계정 · Google 로그인 + 이미 서버 저장이 있는 계정(기존 지인 — 처음 한 번 자동 등록)
  const CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const normCode = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(NIGHT)?/, "").slice(0, 8);
  const invite = {
    on: async () => { try { return (await val("config/inviteOnly")) === true; } catch (e) { return false; } },
    status: async () => { const u = await ready; if (!u) return { ok: true, why: "offline" };
      if (!(await invite.on())) return { ok: true, why: "off" };
      try { if ((await val("admins/" + u.uid)) === true) return { ok: true, why: "admin" }; } catch (e) {}
      try { if (await val("invited/" + u.uid)) return { ok: true, why: "invited" }; } catch (e) { return { ok: false, why: "err", err: (e && (e.code || e.message)) || String(e) }; }
      // v0.94 기존 플레이어(서버에 저장이나 플레이어 기록이 있는 계정)는 게스트든 Google이든 그대로 통과 — 서버 규칙이 확인
      try { await rtdb.ref("invited/" + u.uid).set({ g: true, at: TS }); return { ok: true, why: u.isAnonymous ? "old-guest" : "google" }; } catch (e) {}
      return { ok: false, why: "need", anon: !!u.isAnonymous }; },
    redeem: async raw => { const u = await ready; if (!u) throw new Error("서버에 연결되어 있지 않습니다"); const c = normCode(raw); if (c.length !== 8) throw new Error("코드는 NIGHT- 뒤 8자리입니다");
      const code = "NIGHT-" + c;
      try { await rtdb.ref().update({ ["invites/" + code + "/used"]: u.uid, ["invited/" + u.uid]: { code, at: TS } }); }
      catch (e) { throw new Error("없는 코드이거나 이미 다른 사람이 쓴 코드입니다"); } return code; },
    setOn: async on => { await rtdb.ref("config/inviteOnly").set(!!on); },
    make: async n => { n = Math.max(1, Math.min(100, n | 0)); const up = {}, out = [];
      for (let i = 0; i < n; i++) { let c = "NIGHT-"; const b = new Uint32Array(8); crypto.getRandomValues(b); for (const x of b) c += CODE_ABC[x % CODE_ABC.length]; up["invites/" + c] = { at: TS }; out.push(c); }
      await rtdb.ref().update(up); return out; },
    list: async () => Object.entries((await val("invites")) || {}).map(([code, v]) => Object.assign({ code }, v)).sort((a, b) => (a.at || 0) - (b.at || 0)),
    invited: async () => (await val("invited")) || {},
    revoke: async code => { const v = await val("invites/" + code); const up = { ["invites/" + code]: null }; if (v && v.used) up["invited/" + v.used] = null; await rtdb.ref().update(up); },
    unInvite: async uid => { await rtdb.ref("invited/" + safeKey(uid)).remove(); },
    allowUid: async uid => { await rtdb.ref("invited/" + safeKey(uid)).set({ by: "admin", at: TS }); }
  };
  window.PNNet = { lend, auth: authApi, ops, invite,
    settingsHTML: () => `<div class="sblock"><div class="slabel">계정 · 서버 저장</div><div id="pnAcct">${acctInner()}</div></div>`,
    bindSettings: () => bind(document.getElementById("pnAcct")),
    ready, get user() { return user; }
  };
})();
