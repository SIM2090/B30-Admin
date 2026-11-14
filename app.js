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

  /** @type {{ updated: string, note?: string, devices: any[] }} */
  let doc = { updated: today(), devices: [] };
  let sha = null;
  let editIndex = -1;
  let dirty = false;

  function today() {
    return new Date().toISOString().slice(0, 10);
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
      headers: { ...apiHeaders(opts.json ? { "Content-Type": "application/json" } : null), ...(opts.headers || {}) },
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

  /** Match Python json.dumps(..., ensure_ascii=False, sort_keys=True, separators=(",", ":")) */
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

  function filteredDevices() {
    const q = ($("search").value || "").trim().toLowerCase();
    if (!q) return doc.devices.map((d, i) => ({ d, i }));
    return doc.devices
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => `${d.name} ${d.hwid}`.toLowerCase().includes(q));
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function render() {
    const rows = filteredDevices();
    tbody.innerHTML = "";
    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:28px">دستگاهی نیست — «دستگاه جدید» را بزنید</td></tr>';
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
    hwidCount.textContent = `${doc.devices.length} دستگاه${dirty ? " · ذخیره نشده" : ""}`;
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
    setStatus("در حال بارگذاری...");
    const data = await gh(`/repos/${CFG.licensesRepo}/contents/${CFG.devicesPath}`);
    sha = data.sha;
    const parsed = JSON.parse(base64ToUtf8(data.content));
    doc = {
      updated: parsed.updated || today(),
      note: parsed.note || "پنل مجوز B30 — مدیریت آنلاین",
      devices: Array.isArray(parsed.devices) ? parsed.devices.map(normalizeDevice) : [],
    };
    dirty = false;
    render();
    setStatus("بارگذاری شد", true);
  }

  async function saveDevices() {
    doc.updated = today();
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
      render();
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
      const release = await ensureRelease();
      await uploadSignedAsset(release, "devices.signed.json", signed);
      setStatus("منتشر شد — برنامه در اتصال بعدی لیست جدید را می‌گیرد", true);
    } finally {
      $("btn-publish").disabled = false;
    }
  }

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
      await loadDevices();
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
    loadDevices().catch((e) => setStatus(e.message, false))
  );
  $("btn-save").addEventListener("click", () =>
    saveDevices().catch((e) => setStatus(e.message, false))
  );
  $("btn-publish").addEventListener("click", () =>
    publish().catch((e) => setStatus(e.message, false))
  );
  $("btn-add").addEventListener("click", () => openEditor(-1));
  $("search").addEventListener("input", render);

  tbody.addEventListener("click", (ev) => {
    const edit = ev.target.closest("[data-edit]");
    const del = ev.target.closest("[data-del]");
    if (edit) openEditor(Number(edit.dataset.edit));
    if (del) {
      const i = Number(del.dataset.del);
      const name = doc.devices[i]?.name || "";
      if (!confirm(`حذف «${name}»؟`)) return;
      doc.devices.splice(i, 1);
      dirty = true;
      render();
      setStatus("حذف شد — هنوز ذخیره نشده", false);
    }
  });

  $("btn-dialog-save").addEventListener("click", (ev) => {
    ev.preventDefault();
    const device = normalizeDevice({
      name: $("f-name").value,
      hwid: $("f-hwid").value,
      max_intersections: $("f-max").value,
      exp: $("f-exp").value,
      enabled: $("f-enabled").checked,
    });
    if (!device.hwid) return;
    const dup = doc.devices.findIndex((d, i) => d.hwid === device.hwid && i !== editIndex);
    if (dup >= 0) {
      alert("این HWID قبلاً ثبت شده است");
      return;
    }
    if (editIndex >= 0) doc.devices[editIndex] = device;
    else doc.devices.push(device);
    dirty = true;
    dialog.close();
    render();
    setStatus("تغییر اعمال شد — ذخیره یا انتشار را بزنید", false);
  });

  if (getToken() && getPem()) {
    showApp(true);
    loadDevices().catch((e) => {
      setStatus(e.message, false);
      clearCreds();
      showApp(false);
    });
  }
})();
