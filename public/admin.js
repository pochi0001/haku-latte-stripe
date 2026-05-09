async function api(path, opts){
  const res = await fetch(path, opts);
  const data = await res.json().catch(()=>null);
  if(!res.ok) throw new Error((data && (data.error || data.details)) || res.statusText);
  return data;
}

function escHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, (m)=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}

function yen(n){ return "¥" + Number(n||0).toLocaleString(); }

function setImgStatus(id, msg, ok){
  const el = document.getElementById("img-status-" + id);
  if(!el) return;
  el.textContent = msg || "";
  el.style.color = ok ? "green" : "crimson";
}

function safeItemsHtml(o){
  try{
    if(!o.items_json) return escHtml(o.description || "");
    const arr = JSON.parse(o.items_json);
    if(!Array.isArray(arr) || !arr.length) return escHtml(o.description || "");
    return "<ul>" + arr.map(it=>{
      const name = escHtml(it.name || "");
      const price = Number(it.price||0);
      const qty = Number(it.qty||1);
      const q = qty === 1 ? "" : (" ×" + qty);
      return "<li>" + name + q + "（" + yen(price) + "）</li>";
    }).join("") + "</ul>";
  }catch{
    return escHtml(o.description || "");
  }
}

async function loadProducts(){
  const items = await api("/admin/api/products");
  const el = document.getElementById("products");

  let html = `
    <table>
      <thead>
        <tr>
          <th>ID</th><th>画像</th><th>商品名</th><th>価格</th><th>在庫</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
  `;

  for(const p of items){
    const id = Number(p.id);
    const imgUrl = "/img/" + id + ".jpg?ts=" + Date.now();

    html += `
      <tr>
        <td><span class="badge">#${id}</span></td>

        <td>
          <img class="thumb" src="${imgUrl}" onerror="this.style.opacity=0.25" alt="">
        </td>

        <td>
          <input class="name" data-id="${id}" value="${escHtml(p.name)}" style="width:100%">
        </td>

        <td>
          <input class="price" data-id="${id}" type="number" min="0" value="${Number(p.price||0)}" style="width:120px">
        </td>

        <td>
          <input class="stock" data-id="${id}" type="number" min="0" value="${Number(p.stock||0)}" style="width:90px">
        </td>

        <td>
          <div class="row">
            <button class="btn-save" data-id="${id}">更新</button>
            <button class="btn-del secondary" data-id="${id}">削除</button>
          </div>

          <div class="row" style="margin-top:8px;">
            <input class="img-input" data-id="${id}" type="file" accept="image/*">
            <button class="btn-upload secondary" data-id="${id}">画像アップ</button>
            <button class="btn-img-del secondary" data-id="${id}">画像削除</button>
          </div>

          <div class="muted" id="img-status-${id}" style="margin-top:6px;"></div>
        </td>
      </tr>
    `;
  }

  html += "</tbody></table>";
  el.innerHTML = html;

  // ---- 更新 ----
  document.querySelectorAll(".btn-save").forEach(btn=>{
    btn.onclick = async ()=>{
      const id = Number(btn.dataset.id);
      const name  = document.querySelector(`.name[data-id="${id}"]`).value.trim();
      const price = Number(document.querySelector(`.price[data-id="${id}"]`).value);
      const stock = Number(document.querySelector(`.stock[data-id="${id}"]`).value);

      if(!name) return alert("商品名が空です");
      if(!Number.isFinite(price) || price < 0) return alert("価格が不正です");
      if(!Number.isFinite(stock) || stock < 0) return alert("在庫が不正です");

      await api(`/admin/api/products/${id}`, {
        method:"PATCH",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ name, price, stock })
      });

      alert("更新しました");
      await loadProducts();
    };
  });

  // ---- 削除 ----
  document.querySelectorAll(".btn-del").forEach(btn=>{
    btn.onclick = async ()=>{
      const id = Number(btn.dataset.id);
      if(!confirm(`商品 #${id} を削除しますか？`)) return;
      await api(`/admin/api/products/${id}`, { method:"DELETE" });
      alert("削除しました");
      await loadProducts();
    };
  });

  // ---- 画像アップ ----
  document.querySelectorAll(".btn-upload").forEach(btn=>{
    btn.onclick = async ()=>{
      const id = Number(btn.dataset.id);
      const fileInput = document.querySelector(`.img-input[data-id="${id}"]`);
      const file = fileInput && fileInput.files && fileInput.files[0];
      if(!file) return alert("画像ファイルを選択してください");

      setImgStatus(id, "アップロード中…", true);

      const fd = new FormData();
      fd.append("image", file);

      const res = await fetch(`/admin/api/products/${id}/image`, { method:"POST", body: fd });
      const data = await res.json().catch(()=>null);

      if(!res.ok){
        setImgStatus(id, (data && (data.error||data.details)) || "アップロード失敗", false);
        return;
      }

      setImgStatus(id, "✓ 更新しました", true);

      const img = btn.closest("tr").querySelector("img.thumb");
      if(img){
        img.src = "/img/" + id + ".jpg?ts=" + ((data && data.ts) || Date.now());
      }
    };
  });

  // ---- 画像削除 ----
  document.querySelectorAll(".btn-img-del").forEach(btn=>{
    btn.onclick = async ()=>{
      const id = Number(btn.dataset.id);
      if(!confirm(`画像を削除しますか？（/img/${id}.jpg）`)) return;

      setImgStatus(id, "削除中…", true);

      const res = await fetch(`/admin/api/products/${id}/image`, { method:"DELETE" });
      const data = await res.json().catch(()=>null);

      if(!res.ok){
        setImgStatus(id, (data && (data.error||data.details)) || "削除失敗", false);
        return;
      }

      setImgStatus(id, "✓ 画像を削除しました", true);

      const img = btn.closest("tr").querySelector("img.thumb");
      if(img){
        img.src = "/img/" + id + ".jpg?ts=" + Date.now(); // 404→薄く表示
      }
    };
  });
}

async function loadOrders(){
  const el = document.getElementById("orders");
  if(!el) return;

  const rows = await api("/admin/api/orders");

  if(!rows.length){
    el.innerHTML = "<div class='muted'>注文はまだありません</div>";
    return;
  }

  let html = `
    <table>
      <thead>
        <tr><th>日時</th><th>購入者</th><th>連絡先</th><th>内容</th><th>金額</th><th>決済</th></tr>
      </thead>
      <tbody>
  `;

  for(const o of rows){
    html += `
      <tr>
        <td>${escHtml(o.created_at || "")}</td>
        <td>${escHtml(o.name || "")}<div class="muted">${escHtml(o.address || "")}</div></td>
        <td>${escHtml(o.email || "")}<div class="muted">${escHtml(o.phone || "")}</div></td>
        <td>${safeItemsHtml(o)}</td>
        <td>${yen(o.amount)}</td>
        <td class="muted">${escHtml(o.method || "")}</td>
      </tr>
    `;
  }

  html += "</tbody></table>";
  el.innerHTML = html;
}

// ---- 追加 ----
document.getElementById("btn-add").onclick = async ()=>{
  const newName  = document.getElementById("new-name");
  const newPrice = document.getElementById("new-price");
  const newStock = document.getElementById("new-stock");

  const name = newName.value.trim();
  const price = Number(newPrice.value);
  const stock = Number(newStock.value);

  if(!name) return alert("商品名が空です");
  if(!Number.isFinite(price) || price < 0) return alert("価格が不正です");
  if(!Number.isFinite(stock) || stock < 0) return alert("在庫が不正です");

  const ret = await api("/admin/api/products", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ name, price, stock })
  });

  newName.value=""; newPrice.value=""; newStock.value="";
  alert(`追加しました（id=${ret.id}） 画像は /img/${ret.id}.jpg`);
  await loadProducts();
};

(async ()=>{
  await loadProducts();
  await loadOrders();
})();