(() => {
  const CFG = window.B30_ADMIN;
  const TOKEN_KEY = "b30_admin_gh_token";
  const PEM_KEY = "b30_admin_pem";

  const $ = (id) => document.getElementById(id);
  const loginView = $("login-view");
  const appView = $("app-view");
  const statusText = $("status-text");
  const hwidCount = $("hwid-count");
  const tbody = $("devices-body");
  const dialog = $("edit-dialog");
  const approveDialog = $("approve-dialog");
  const shotDialog = $("shot-dialog");
  const requestsList = $("requests-list");

  /** @type {{ updated: string, note?: string, devices: any[] }} */
  let doc = { updated: today(), devices: [] };
  let sha = null;
  let editIndex = -1;
  let dirty = false;
  /** @type {any[]} */
  let requests = [];
  let approveTarget = null;

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function nowStamp() {
    // برای انتخاب جدیدترین رجیستری توسط برنامه
    return new Date().toISOString();
  }

  async function saveAndPublish() {
    await saveDevices();
    await publish();
  }

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  }
  function getPem() {
    return sessionStorage.getItem(PEM_KEY) || "";
  }
  function setCreds(token, pem) {
    sessionStorage.setItem(TOKEN_KEY, token.trim());
    sessionStorage.setItem(PEM_KEY, pem.trim());
  }
  function clearCreds() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(PEM_KEY);
  }

  function setStatus(msg, ok) {
    statusText.textContent = msg;
    statusText.style.color = ok === false ? "var(--danger)" : ok === true ? "var(--ok)" : "";
  }

  function apiHeaders(extra) {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${getToken()}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(extra || {}),
    };
  }

  async function gh(path, opts = {}) {
    const res = await fetch(`https://api.github.com${path}`, {
      ...opts,
      headers: {
        ...apiHeaders(opts.json ? { "Content-Type": "application/json" } : null),
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { message: text };
    }
    if (!res.ok) {
      throw new Error((body && body.message) || res.statusText);
    }
    return body;
  }

  function showApp(show) {
    loginView.hidden = show;
    appView.hidden = !show;
  }

  function normalizeDevice(d) {
    return {
      hwid: String(d.hwid || "").trim().toUpperCase(),
      name: String(d.name || "").trim() || "بدون نام",
      max_intersections: Math.max(1, parseInt(d.max_intersections, 10) || 1),
      enabled: d.enabled !== false,
      exp: String(d.exp || "2099-12-31").slice(0, 10),
    };
  }

  function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object") {
      const out = {};
      for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
      return out;
    }
    return value;
  }

  function canonicalPayload(data) {
    return JSON.stringify(sortKeys(data));
  }

  function signPayload(payload) {
    if (typeof KJUR === "undefined") throw new Error("کتابخانه امضا لود نشد");
    const pem = getPem();
    if (!pem.includes("PRIVATE KEY")) throw new Error("کلید خصوصی معتبر نیست");
    const sig = new KJUR.crypto.Signature({ alg: "SHA256withRSA" });
    sig.init(pem);
    sig.updateString(payload);
    return hextob64(sig.sign());
  }

  function utf8ToBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  function base64ToUtf8(b64) {
    return decodeURIComponent(escape(atob(b64.replace(/\n/g, ""))));
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function filteredDevices() {
    const q = ($("search").value || "").trim().toLowerCase();
    if (!q) return doc.devices.map((d, i) => ({ d, i }));
    return doc.devices
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => `${d.name} ${d.hwid}`.toLowerCase().includes(q));
  }

  function renderDevices() {
    const rows = filteredDevices();
    tbody.innerHTML = "";
    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:28px">دستگاهی نیست</td></tr>';
    } else {
      for (const { d, i } of rows) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${escapeHtml(d.name)}</td>
          <td class="hwid-cell">${escapeHtml(d.hwid)}</td>
          <td>${d.max_intersections}</td>
          <td>${escapeHtml(d.exp)}</td>
          <td><span class="badge ${d.enabled ? "on" : "off"}">${d.enabled ? "فعال" : "قطع"}</span></td>
          <td>
            <div class="row-actions">
              <button type="button" class="btn ghost" data-edit="${i}">ویرایش</button>
              <button type="button" class="btn danger" data-del="${i}">حذف</button>
            </div>
          </td>`;
        tbody.appendChild(tr);
      }
    }
    hwidCount.textContent = `${doc.devices.length} دستگاه · ${requests.length} درخواست${dirty ? " · ذخیره نشده" : ""}`;
  }

  function mediaUrl(path) {
    return `https://api.github.com/repos/${CFG.inboxRepo}/contents/${path}`;
  }

  async function fetchFileJson(path) {
    const data = await gh(`/repos/${CFG.inboxRepo}/contents/${path}`);
    return { sha: data.sha, json: JSON.parse(base64ToUtf8(data.content)), path, name: data.name };
  }

  async function fetchRawImageObjectUrl(path) {
    const data = await gh(`/repos/${CFG.inboxRepo}/contents/${path}`);
    const bin = atob(data.content.replace(/\n/g, ""));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([arr], { type: "image/jpeg" }));
  }

  function renderRequests() {
    const badge = $("req-badge");
    if (requests.length) {
      badge.hidden = false;
      badge.textContent = String(requests.length);
    } else {
      badge.hidden = true;
    }
    requestsList.innerHTML = "";
    if (!requests.length) {
      requestsList.innerHTML =
        '<div class="req-card" style="display:block;text-align:center;color:var(--muted);padding:28px">درخواست معلقی نیست</div>';
      renderDevices();
      return;
    }
    for (const r of requests) {
      const card = document.createElement("article");
      card.className = "req-card";
      const shotHtml = r.shotUrl
        ? `<img class="req-shot" src="${r.shotUrl}" alt="screenshot" data-shot="${escapeHtml(r.shotUrl)}" />`
        : `<div class="req-shot placeholder">بدون عکس</div>`;
      const locals = (r.local_ips || []).join(", ") || "—";
      card.innerHTML = `
        ${shotHtml}
        <div>
          <dl class="req-meta">
            <div><dt>IP عمومی</dt><dd class="mono">${escapeHtml(r.public_ip || "—")}</dd></div>
            <div><dt>IP محلی</dt><dd class="mono">${escapeHtml(locals)}</dd></div>
            <div><dt>سیستم</dt><dd>${escapeHtml(r.hostname || "—")} / ${escapeHtml(r.username || "—")}</dd></div>
            <div><dt>سیستم‌عامل</dt><dd>${escapeHtml(r.os || "—")}</dd></div>
            <div><dt>نسخه برنامه</dt><dd>${escapeHtml(r.app_version || "—")}</dd></div>
            <div><dt>زمان</dt><dd>${escapeHtml(r.collected_at || "—")}</dd></div>
            <div style="grid-column:1/-1"><dt>HWID (فقط برای شما)</dt><dd class="mono">${escapeHtml(r.hwid || "—")}</dd></div>
          </dl>
        </div>
        <div class="req-actions">
          <button type="button" class="btn primary" data-approve="${escapeHtml(r.id)}">تأیید دسترسی</button>
          <button type="button" class="btn danger" data-deny="${escapeHtml(r.id)}">رد</button>
        </div>`;
      requestsList.appendChild(card);
    }
    renderDevices();
  }

  async function loadRequests() {
    requests = [];
    let listing;
    try {
      listing = await gh(`/repos/${CFG.inboxRepo}/contents/${CFG.pendingDir}`);
    } catch (e) {
      if (String(e.message || "").includes("Not Found")) {
        renderRequests();
        return;
      }
      throw e;
    }
    const files = (listing || []).filter((f) => f.type === "file" && f.name.endsWith(".json"));
    for (const f of files) {
      try {
        const { sha: fileSha, json } = await fetchFileJson(`${CFG.pendingDir}/${f.name}`);
        let shotUrl = "";
        const shotPath = json.screenshot_path || `${CFG.pendingDir}/${f.name.replace(/\.json$/i, ".jpg")}`;
        if (json.has_screenshot !== false) {
          try {
            shotUrl = await fetchRawImageObjectUrl(shotPath);
          } catch {
            shotUrl = "";
          }
        }
        requests.push({
          ...json,
          id: json.id || f.name.replace(/\.json$/i, ""),
          _sha: fileSha,
          _path: `${CFG.pendingDir}/${f.name}`,
          _shotPath: shotPath,
          shotUrl,
        });
      } catch (e) {
        console.warn(e);
      }
    }
    requests.sort((a, b) => String(b.collected_at || "").localeCompare(String(a.collected_at || "")));
    renderRequests();
  }

  async function deleteInboxPath(path, fileSha, message) {
    await gh(`/repos/${CFG.inboxRepo}/contents/${path}`, {
      method: "DELETE",
      json: true,
      body: JSON.stringify({ message, sha: fileSha }),
    });
  }

  async function resolveRequestFileSha(path) {
    const data = await gh(`/repos/${CFG.inboxRepo}/contents/${path}`);
    return data.sha;
  }

  async function removePendingRequest(req) {
    try {
      await deleteInboxPath(req._path, req._sha, `resolve request ${req.id}`);
    } catch (e) {
      // retry with fresh sha
      const s = await resolveRequestFileSha(req._path);
      await deleteInboxPath(req._path, s, `resolve request ${req.id}`);
    }
    if (req.has_screenshot !== false) {
      try {
        const s = await resolveRequestFileSha(req._shotPath);
        await deleteInboxPath(req._shotPath, s, `resolve screenshot ${req.id}`);
      } catch {
        /* no screenshot */
      }
    }
  }

  function openEditor(index) {
    editIndex = index;
    const d =
      index >= 0
        ? doc.devices[index]
        : { name: "", hwid: "", max_intersections: 4, enabled: true, exp: "2099-12-31" };
    $("dialog-title").textContent = index >= 0 ? "ویرایش دستگاه" : "دستگاه جدید";
    $("f-name").value = d.name || "";
    $("f-hwid").value = d.hwid || "";
    $("f-max").value = d.max_intersections || 4;
    $("f-exp").value = d.exp || "2099-12-31";
    $("f-enabled").checked = d.enabled !== false;
    dialog.showModal();
  }

  async function loadDevices() {
    setStatus("در حال بارگذاری دستگاه‌ها...");
    const data = await gh(`/repos/${CFG.licensesRepo}/contents/${CFG.devicesPath}`);
    sha = data.sha;
    let parsed;
    try {
      parsed = JSON.parse(base64ToUtf8(data.content));
    } catch (e) {
      throw new Error(
        "فایل devices.json خراب است (JSON نامعتبر). آن را از GitHub درست کنید یا اینجا دوباره ذخیره کنید."
      );
    }
    doc = {
      updated: parsed.updated || today(),
      note: parsed.note || "پنل مجوز B30 — مدیریت آنلاین",
      devices: Array.isArray(parsed.devices) ? parsed.devices.map(normalizeDevice) : [],
    };
    dirty = false;
    renderDevices();
  }

  async function saveDevices() {
    doc.updated = nowStamp();
    const json = JSON.stringify(doc, null, 2) + "\n";
    setStatus("در حال ذخیره...");
    $("btn-save").disabled = true;
    try {
      const res = await gh(`/repos/${CFG.licensesRepo}/contents/${CFG.devicesPath}`, {
        method: "PUT",
        json: true,
        body: JSON.stringify({
          message: `update devices (${doc.devices.length}) via web panel`,
          content: utf8ToBase64(json),
          sha,
        }),
      });
      sha = res.content.sha;
      dirty = false;
      renderDevices();
      setStatus("ذخیره شد", true);
    } finally {
      $("btn-save").disabled = false;
    }
  }

  async function ensureRelease() {
    try {
      return await gh(`/repos/${CFG.setupRepo}/releases/tags/${CFG.registryTag}`);
    } catch {
      return await gh(`/repos/${CFG.setupRepo}/releases`, {
        method: "POST",
        json: true,
        body: JSON.stringify({
          tag_name: CFG.registryTag,
          name: "B30 License Registry",
          body: "رجیستری مجوز دستگاه‌های B30 — از پنل وب منتشر می‌شود.",
        }),
      });
    }
  }

  async function uploadSignedAsset(release, fileName, content) {
    const existing = (release.assets || []).find((a) => a.name === fileName);
    if (existing) {
      await gh(`/repos/${CFG.setupRepo}/releases/assets/${existing.id}`, { method: "DELETE" });
    }
    const url = `https://uploads.github.com/repos/${CFG.setupRepo}/releases/${release.id}/assets?name=${encodeURIComponent(fileName)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${getToken()}`,
        "Content-Type": "application/octet-stream",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: new Blob([content], { type: "application/octet-stream" }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || res.statusText);
    }
  }

  async function publish() {
    if (!getPem()) throw new Error("کلید خصوصی وارد نشده — دوباره وارد شوید");
    if (dirty) await saveDevices();
    setStatus("در حال امضا و انتشار...");
    $("btn-publish").disabled = true;
    try {
      const payload = canonicalPayload(doc);
      const sig = signPayload(payload);
      const signed = JSON.stringify({ payload, sig }, null, 2) + "\n";
      // 1) Contents API (CORS-safe) — مسیر اصلی
      const cpath = "devices.signed.json";
      let csha = null;
      try {
        const cur = await gh(`/repos/${CFG.setupRepo}/contents/${cpath}`);
        csha = cur.sha;
      } catch (e) {
        if (!String(e.message || "").includes("Not Found")) throw e;
      }
      await gh(`/repos/${CFG.setupRepo}/contents/${cpath}`, {
        method: "PUT",
        json: true,
        body: JSON.stringify({
          message: `publish registry (${doc.devices.length} devices)`,
          content: utf8ToBase64(signed),
          ...(csha ? { sha: csha } : {}),
        }),
      });
      // 2) آپلود release — اختیاری (ممکن است CORS مسدود کند)
      let relNote = "";
      try {
        const release = await ensureRelease();
        await uploadSignedAsset(release, "devices.signed.json", signed);
      } catch (e) {
        console.warn("release upload skipped:", e);
        relNote = " (release رد شد)";
      }
      setStatus("منتشر شد" + relNote + " — برنامه‌ها تا ۲ دقیقه دیگر می‌گیرند", true);
    } finally {
      $("btn-publish").disabled = false;
    }
  }

  async function reloadAll() {
    setStatus("بارگذاری...");
    await loadDevices();
    await loadRequests();
    setStatus("به‌روز شد", true);
  }

  function switchTab(name) {
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === name);
    });
    $("tab-requests").hidden = name !== "requests";
    $("tab-devices").hidden = name !== "devices";
  }

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  $("btn-login").addEventListener("click", async () => {
    const t = $("token-input").value.trim();
    const pem = $("pem-input").value.trim();
    $("login-error").hidden = true;
    if (!t) {
      $("login-error").textContent = "توکن GitHub لازم است";
      $("login-error").hidden = false;
      return;
    }
    if (!pem.includes("PRIVATE KEY")) {
      $("login-error").textContent = "محتوای private.pem را بچسبانید";
      $("login-error").hidden = false;
      return;
    }
    setCreds(t, pem);
    try {
      await gh("/user");
      showApp(true);
      await reloadAll();
    } catch (e) {
      clearCreds();
      $("login-error").textContent = "ورود ناموفق: " + e.message;
      $("login-error").hidden = false;
    }
  });

  $("btn-logout").addEventListener("click", () => {
    clearCreds();
    showApp(false);
    $("token-input").value = "";
    $("pem-input").value = "";
  });

  $("btn-reload").addEventListener("click", () =>
    reloadAll().catch((e) => setStatus(e.message, false))
  );
  $("btn-save").addEventListener("click", () =>
    saveAndPublish().catch((e) => setStatus(e.message, false))
  );
  $("btn-publish").addEventListener("click", () =>
    publish().catch((e) => setStatus(e.message, false))
  );
  $("btn-add").addEventListener("click", () => openEditor(-1));
  $("search").addEventListener("input", renderDevices);

  tbody.addEventListener("click", (ev) => {
    const edit = ev.target.closest("[data-edit]");
    const del = ev.target.closest("[data-del]");
    if (edit) openEditor(Number(edit.dataset.edit));
    if (del) {
      const i = Number(del.dataset.del);
      const name = doc.devices[i]?.name || "";
      if (!confirm(`حذف «${name}»؟\nپس از حذف، دسترسی برنامه قطع می‌شود.`)) return;
      doc.devices.splice(i, 1);
      dirty = true;
      renderDevices();
      setStatus("در حال حذف و انتشار...");
      saveAndPublish()
        .then(() => setStatus("حذف و منتشر شد — برنامه تا ۲ دقیقه دیگر قطع می‌کند", true))
        .catch((e) => setStatus(e.message, false));
    }
  });

  $("btn-dialog-cancel").addEventListener("click", () => dialog.close());
  $("btn-dialog-save").addEventListener("click", async (ev) => {
    ev.preventDefault();
    const device = normalizeDevice({
      name: $("f-name").value,
      hwid: $("f-hwid").value,
      max_intersections: $("f-max").value,
      exp: $("f-exp").value,
      enabled: $("f-enabled").checked,
    });
    if (!device.hwid) {
      alert("HWID را وارد کنید");
      return;
    }
    if (!$("f-name").value.trim()) {
      alert("نام مشتری را وارد کنید");
      return;
    }
    const dup = doc.devices.findIndex((d, i) => d.hwid === device.hwid && i !== editIndex);
    if (dup >= 0) {
      alert("این HWID قبلاً ثبت شده است");
      return;
    }
    if (editIndex >= 0) doc.devices[editIndex] = device;
    else doc.devices.push(device);
    dirty = true;
    dialog.close();
    renderDevices();
    setStatus("در حال ذخیره و انتشار...");
    try {
      await saveAndPublish();
      setStatus("ذخیره و منتشر شد — برنامه تا ۲ دقیقه دیگر می‌گیرد", true);
    } catch (e) {
      setStatus(e.message, false);
    }
  });

  $("btn-approve-cancel").addEventListener("click", () => approveDialog.close());

  requestsList.addEventListener("click", (ev) => {
    const shot = ev.target.closest("[data-shot]");
    if (shot) {
      $("shot-img").src = shot.dataset.shot;
      shotDialog.showModal();
      return;
    }
    const ap = ev.target.closest("[data-approve]");
    const den = ev.target.closest("[data-deny]");
    if (ap) {
      approveTarget = requests.find((r) => r.id === ap.dataset.approve);
      if (!approveTarget) return;
      $("a-name").value = approveTarget.hostname || approveTarget.username || "مشتری جدید";
      $("a-max").value = 4;
      $("a-exp").value = "2099-12-31";
      approveDialog.showModal();
    }
    if (den) {
      const req = requests.find((r) => r.id === den.dataset.deny);
      if (!req) return;
      if (!confirm("این درخواست رد شود؟")) return;
      setStatus("در حال رد درخواست...");
      removePendingRequest(req)
        .then(() => loadRequests())
        .then(() => setStatus("درخواست رد شد", true))
        .catch((e) => setStatus(e.message, false));
    }
  });

  $("btn-shot-close").addEventListener("click", () => shotDialog.close());

  $("btn-approve-confirm").addEventListener("click", async (ev) => {
    ev.preventDefault();
    if (!approveTarget) return;
    const device = normalizeDevice({
      hwid: approveTarget.hwid,
      name: $("a-name").value,
      max_intersections: $("a-max").value,
      exp: $("a-exp").value,
      enabled: true,
    });
    const idx = doc.devices.findIndex((d) => d.hwid === device.hwid);
    if (idx >= 0) doc.devices[idx] = device;
    else doc.devices.push(device);
    dirty = true;
    approveDialog.close();
    try {
      setStatus("تأیید و انتشار...");
      await saveDevices();
      await publish();
      await removePendingRequest(approveTarget);
      approveTarget = null;
      await loadRequests();
      setStatus("دسترسی تأیید و منتشر شد", true);
    } catch (e) {
      setStatus(e.message, false);
    }
  });

  if (getToken() && getPem()) {
    showApp(true);
    reloadAll().catch((e) => {
      setStatus(e.message, false);
      clearCreds();
      showApp(false);
    });
  }
})();
