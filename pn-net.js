/* 프로젝트 나이트 — 휴대폰 테스트 배포본(GitHub Pages) 전용 서버 연결 (Firebase)
   게임 본문은 아티팩트의 window.claude.use("room" | "db" | "user") 를 쓰므로, 여기서 같은 모양의 함수를 Firebase로 만들어 끼운다.
   - 계정: 처음엔 익명 로그인(가입 없이 바로) · 설정에서 Google 계정을 연결하면 다른 기기에서도 같은 진행
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
  let user = null, readyRes; const ready = new Promise(r => readyRes = r);
  auth.onAuthStateChanged(u => {
    if (u) { user = u; readyRes(u); render(); }
    else auth.signInAnonymously().catch(e => { console.warn("[PNNet] 익명 로그인 실패", e); readyRes(null); });
  });
  setTimeout(() => readyRes(null), 15000);   // 15초 안에 로그인이 안 되면 이 기기에만 저장(함께하기 꺼짐)

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
    if (user.isAnonymous) return `<p class="msub">지금은 <b>손님 계정</b>입니다 — 진행은 서버에 저장되지만 이 기기·이 브라우저에서만 이어집니다. Google 계정을 연결하면 다른 휴대폰·PC에서도 같은 진행으로 이어 할 수 있어요.</p>
      <div class="srow"><button class="btn" data-pn="google">Google 계정 연결</button></div>`;
    return `<p class="msub">Google 계정 <b>${esc(user.email || user.displayName)}</b>으로 로그인됨 — 어느 기기에서 열어도 같은 진행이 이어집니다.</p>
      <div class="srow"><button class="btn ghost" data-pn="out">로그아웃</button></div>`;
  }
  function bind(el) { if (!el) return;
    const g = el.querySelector('[data-pn="google"]'); if (g) g.onclick = google;
    const o = el.querySelector('[data-pn="out"]'); if (o) o.onclick = async () => { if (!confirmBox("로그아웃하면 이 기기는 새 손님 계정으로 처음부터 시작합니다(진행은 Google 계정에 남아 있음). 로그아웃할까요?")) return;
      try { localStorage.removeItem("pn_progress_v02"); localStorage.removeItem("pn_rules_v01"); } catch (e) {}
      await auth.signOut(); location.reload(); };
  }
  function confirmBox(t) { try { return window.confirm(t); } catch (e) { return true; } }
  async function google() {
    const prov = new fb.auth.GoogleAuthProvider(); prov.setCustomParameters({ prompt: "select_account" });
    try { await user.linkWithPopup(prov); await auth.currentUser.reload(); user = auth.currentUser; render(); note("Google 계정을 연결했습니다 — 이제 다른 기기에서도 이 진행이 이어집니다."); }
    catch (e) {
      if (e && e.code === "auth/credential-already-in-use" && e.credential) {
        // 이 Google 계정은 이미 다른 기기에서 쓰던 계정 → 그 계정으로 들어가고, 그쪽 진행을 불러온다(이 기기 진행은 게임이 백업해 둠)
        if (!confirmBox("이 Google 계정에는 이미 다른 기기에서 저장한 진행이 있습니다. 그 진행으로 바꿀까요? (이 기기의 지금 진행 대신 그 계정의 진행으로 바뀝니다)")) return;
        try { const pg = localStorage.getItem("pn_progress_v02"), rl = localStorage.getItem("pn_rules_v01");
          if (pg) localStorage.setItem("pn_local_backup", JSON.stringify({ progress: JSON.parse(pg), rules: rl ? JSON.parse(rl) : null, at: Date.now() }));
          localStorage.removeItem("pn_progress_v02"); localStorage.removeItem("pn_rules_v01"); } catch (x) {}
        await auth.signInWithCredential(e.credential); location.reload(); return; }
      if (e && (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request")) return;
      note("Google 연결에 실패했습니다: " + ((e && (e.code || e.message)) || e));
    }
  }
  function note(t) { try { if (typeof window.toast === "function") window.toast(esc(t)); else alert(t); } catch (e) {} }
  window.PNNet = {
    settingsHTML: () => `<div class="sblock"><div class="slabel">계정 · 서버 저장</div><div id="pnAcct">${acctInner()}</div></div>`,
    bindSettings: () => bind(document.getElementById("pnAcct")),
    ready, get user() { return user; }
  };
})();
