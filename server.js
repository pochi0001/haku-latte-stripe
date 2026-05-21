// server.js (Haku Latte. 完全版：Square決済 + SQLite + 管理画面 + 画像アップ + 注文整形 + CSV)
import express from "express";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import nodemailer from "nodemailer";
import squarePkg from "square";
import https from "https";
import fs from "fs";
import path from "path";
import multer from "multer";
import sharp from "sharp";

import crypto from "crypto";
import fetch from "node-fetch";


dotenv.config(); // ✅ 必ず最初！

// ==============================
// 基本設定
// ==============================
const { SquareClient, SquareEnvironment } = squarePkg;

const isProd = process.env.SQUARE_ENV === "production";
const isRender = !!process.env.RENDER;
const PORT = Number(process.env.PORT || 3000);

// Renderは /var/data が永続ディスクの定番（あなたの設定に合わせて DB_PATH を使う）
const DB_PATH = process.env.DB_PATH || "./database.db";

// 画像は Render なら永続ディスク配下に置くのが安全
// 例：IMG_DIR=/var/data/img
const IMG_DIR = process.env.IMG_DIR || path.join(process.cwd(), "public", "img");

// ==============================
// Express
// ==============================
const app = express();
app.use(express.json());

// Renderはプロキシ(HTTPS終端)配下
if (isRender) app.set("trust proxy", 1);

// ログ
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

// フロントは /img/{id}.jpg 参照のままでOK
app.use("/img", express.static(IMG_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});


// 静的ファイル（public 配下）
app.use(express.static("public"));

// ==============================
// 画像配信＆アップロード
// ==============================
fs.mkdirSync(IMG_DIR, { recursive: true });


// ==============================
// Square
// ==============================
const client = new SquareClient({
  token: isProd
    ? process.env.SQUARE_PRODUCTION_ACCESS_TOKEN
    : process.env.SQUARE_SANDBOX_ACCESS_TOKEN,
  environment: isProd ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
});

const locationId = isProd
  ? process.env.SQUARE_PRODUCTION_LOCATION_ID
  : process.env.SQUARE_SANDBOX_LOCATION_ID;

// ==============================
// SQLite
// ==============================
const dbPromise = open({
  filename: DB_PATH,
  driver: sqlite3.Database,
});

// ==============================
// DB初期化（items_json 追加 + seed任意）
// ==============================
async function initDb() {
  const db = await dbPromise;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount INTEGER NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      method TEXT NOT NULL,
      name TEXT,
      address TEXT,
      phone TEXT,
      email TEXT
    );






    CREATE TABLE IF NOT EXISTS paypay_pending_orders (
      merchant_payment_id TEXT PRIMARY KEY,
      amount INTEGER NOT NULL,
      items_json TEXT NOT NULL,
      name TEXT,
      address TEXT,
      phone TEXT,
      email TEXT,
      status TEXT NOT NULL DEFAULT 'CREATED',
      created_at TEXT NOT NULL
    );








  `);

  // ✅ items_json を後付け（既存DBでも壊さない）
  try {
    await db.exec(`ALTER TABLE payments ADD COLUMN items_json TEXT`);
    console.log("✅ payments.items_json added");
  } catch (_) {
    // 既にあればOK
  }

  // ✅ SEED_DB=true のときだけ、productsが空なら初期商品を入れる
  const shouldSeed = (process.env.SEED_DB || "").toLowerCase() === "true";
  const row = await db.get("SELECT COUNT(*) AS c FROM products");
  const count = Number(row?.c || 0);

  if (shouldSeed && count === 0) {
    await db.run("INSERT INTO products (name, price, stock) VALUES (?,?,?)", [
      "Haku Latte.",
      3000,
      100,
    ]);

    console.log("✅ DB seeded (SEED_DB=true)");
  }
}

// ==============================
// Mail
// ==============================
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

app.post("/contact", async (req, res) => {
  const { name, email, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ error: "入力が不足しています" });
  }

  try {
    await transporter.sendMail({
      from: `"Haku Latte. Contact" <${process.env.MAIL_USER}>`,
      to: "info.vfes0220@gmail.com",
      replyTo: email,
      subject: "【Haku Latte.】お問い合わせ",
      text: `
お名前：${name}
メール：${email}

内容：
${message}
      `,
    });

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "メール送信に失敗しました" });
  }
});

// ==============================
// Basic認証（管理画面）
// ==============================
function requireAdmin(req, res, next) {
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASS;

  if (!user || !pass) {
    return res.status(500).send("ADMIN_USER / ADMIN_PASS が未設定です");
  }

  const auth = req.headers.authorization || "";
  const [type, encoded] = auth.split(" ");
  if (type !== "Basic" || !encoded) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Auth required");
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const [u, p] = decoded.split(":");

  if (u === user && p === pass) return next();

  res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
  return res.status(401).send("Invalid credentials");
}

// ==============================
// square-config（checkout.html用）
// ==============================
app.get("/square-config", (_req, res) => {
  const prod = process.env.SQUARE_ENV === "production";
  res.json({
    env: prod ? "production" : "sandbox",
    appId: prod
      ? process.env.SQUARE_PRODUCTION_APP_ID
      : process.env.SQUARE_SANDBOX_APP_ID,
    locationId: prod
      ? process.env.SQUARE_PRODUCTION_LOCATION_ID
      : process.env.SQUARE_SANDBOX_LOCATION_ID,
  });
});

// ==============================
// 商品一覧 API（フロント表示）
// ==============================
app.get("/products", async (_req, res) => {
  try {
    const db = await dbPromise;
    const products = await db.all("SELECT * FROM products ORDER BY id ASC");
    res.json(products);
  } catch (e) {
    console.error("❌ /products error:", e);
    res.status(500).json({ error: "DB error", details: e.message });
  }
});

// ==============================
// ✅ 管理ページ（外部ファイル版）
// public/admin.html を返すだけ（HTMLベタ書きは完全に廃止）
// ==============================
app.get("/admin", requireAdmin, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "admin.html"));
});

// ==============================
// 管理API：商品一覧
// ==============================
app.get("/admin/api/products", requireAdmin, async (_req, res) => {
  try {
    const db = await dbPromise;
    const rows = await db.all("SELECT * FROM products ORDER BY id ASC");
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "DB error", details: e.message });
  }
});

// 管理API：商品追加（id 自動採番）
app.post("/admin/api/products", requireAdmin, async (req, res) => {
  try {
    const { name, price, stock } = req.body || {};
    const n = String(name || "").trim();
    const p = Number(price);
    const s = Number(stock);

    if (!n) return res.status(400).json({ error: "name が空です" });
    if (!Number.isFinite(p) || p < 0)
      return res.status(400).json({ error: "price が不正です" });
    if (!Number.isFinite(s) || s < 0)
      return res.status(400).json({ error: "stock が不正です" });

    const db = await dbPromise;
    const r = await db.run(
      "INSERT INTO products (name, price, stock) VALUES (?,?,?)",
      [n, p, s]
    );
    return res.json({ success: true, id: r.lastID });
  } catch (e) {
    return res.status(500).json({ error: "DB error", details: e.message });
  }
});

// ✅ 商品画像削除（/img/{id}.jpg を削除）
app.delete("/admin/api/products/:id/image", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "idが不正です" });

    const target = path.join(IMG_DIR, `${id}.jpg`);

    // 無ければ success 扱い（運用がラク）
    if (!fs.existsSync(target)) return res.json({ success: true, deleted: false });

    fs.unlinkSync(target);
    return res.json({ success: true, deleted: true });
  } catch (e) {
    console.error("❌ image delete error:", e);
    return res.status(500).json({ error: "delete failed", details: e.message });
  }
});

// 管理API：商品更新（商品名/価格/在庫 全部）
app.patch("/admin/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, price, stock } = req.body || {};

    if (!Number.isFinite(id)) return res.status(400).json({ error: "id が不正です" });

    const fields = [];
    const values = [];

    if (typeof name === "string") {
      const n = name.trim();
      if (!n) return res.status(400).json({ error: "name が空です" });
      fields.push("name = ?");
      values.push(n);
    }
    if (price !== undefined) {
      const p = Number(price);
      if (!Number.isFinite(p) || p < 0) return res.status(400).json({ error: "price が不正です" });
      fields.push("price = ?");
      values.push(p);
    }
    if (stock !== undefined) {
      const s = Number(stock);
      if (!Number.isFinite(s) || s < 0) return res.status(400).json({ error: "stock が不正です" });
      fields.push("stock = ?");
      values.push(s);
    }

    if (!fields.length) return res.status(400).json({ error: "更新項目がありません" });

    values.push(id);

    const db = await dbPromise;
    await db.run(`UPDATE products SET ${fields.join(", ")} WHERE id = ?`, values);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "DB error", details: e.message });
  }
});

// 管理API：商品削除
app.delete("/admin/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "id が不正です" });

    const db = await dbPromise;
    await db.run("DELETE FROM products WHERE id = ?", [id]);

    // 画像も一緒に削除（あってもなくてもOK）
    try {
      fs.unlinkSync(path.join(IMG_DIR, `${id}.jpg`));
    } catch (_) {}

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "DB error", details: e.message });
  }
});

// ✅ 商品画像アップロード（png/webp/jpg → jpg に変換して保存）
app.post("/admin/api/products/:id/image", requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "id が不正です" });
    if (!req.file) return res.status(400).json({ error: "image がありません" });

    const outPath = path.join(IMG_DIR, `${id}.jpg`);

    const jpgBuffer = await sharp(req.file.buffer)
      .rotate()
      .resize(1000, 1000, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    fs.writeFileSync(outPath, jpgBuffer);

    return res.json({ success: true, path: `/img/${id}.jpg`, ts: Date.now() });
  } catch (e) {
    console.error("❌ image upload error:", e);
    return res.status(500).json({ error: "upload failed", details: e.message });
  }
});

// 管理API：注文一覧（最新50件）
app.get("/admin/api/orders", requireAdmin, async (_req, res) => {
  try {
    const db = await dbPromise;
    const rows = await db.all("SELECT * FROM payments ORDER BY id DESC LIMIT 50");
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "DB error", details: e.message });
  }
});

// 管理API：注文CSV（items_jsonも出す）
app.get("/admin/api/orders.csv", requireAdmin, async (req, res) => {
  try {
    const db = await dbPromise;
    const limit = Math.min(Number(req.query.limit || 5000), 20000);
    const rows = await db.all("SELECT * FROM payments ORDER BY id DESC LIMIT ?", [limit]);

    const BOM = "\uFEFF";
    const headers = ["id","created_at","amount","description","items_json","method","name","address","phone","email"];
    const esc = (v) => `"${(v ?? "").toString().replace(/"/g, '""')}"`;

    const lines = [];
    lines.push(headers.map(esc).join(","));
    for (const r of rows) {
      lines.push(
        [
          r.id, r.created_at, r.amount, r.description, r.items_json || "",
          r.method, r.name, r.address, r.phone, r.email
        ].map(esc).join(",")
      );
    }

    const csv = BOM + lines.join("\r\n");
    const date = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="orders_${date}.csv"`);
    return res.send(csv);
  } catch (e) {
    console.error("❌ /admin/api/orders.csv error:", e);
    return res.status(500).json({ error: "CSV export failed", details: e.message });
  }
});

// ==============================
// Square決済（items_json保存 / 複数商品qty対応）
// cart: [{id: 1, qty: 2}, ...] か [{id:1}, ...] でもOK
// ==============================
app.post("/payment", async (req, res) => {
  console.log("✅ /payment hit");
  console.log("body:", req.body);

  const paymentsMode =
    client.paymentsApi?.createPayment ? "paymentsApi" :
    client.payments?.create ? "payments" :
    null;

  if (!paymentsMode) return res.status(500).json({ error: "Payments API が見つかりません" });

  try {
    const { sourceId, idempotencyKey, cart, email, name, address, phone } = req.body || {};

    if (!sourceId || !idempotencyKey || !email || !name || !address || !phone) {
      return res.status(400).json({ error: "必要な値が不足しています" });
    }
    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: "カートが空です" });
    }

    // cart を正規化（qty省略なら1）
    const normCart = cart.map((it) => ({
      id: Number(it?.id),
      qty: Math.max(1, Number(it?.qty || 1)),
    })).filter((it) => Number.isFinite(it.id) && Number.isFinite(it.qty));

    if (!normCart.length || normCart.length !== cart.length) {
      return res.status(400).json({ error: "カート内容が不正です" });
    }

    const db = await dbPromise;

    // 商品取得
    const ids = [...new Set(normCart.map((x) => x.id))];
    const placeholders = ids.map(() => "?").join(",");
    const rows = await db.all(`SELECT * FROM products WHERE id IN (${placeholders})`, ids);
    const rowMap = new Map(rows.map((p) => [p.id, p]));

    for (const x of normCart) {
      if (!rowMap.has(x.id)) return res.status(404).json({ error: `商品が存在しません (id=${x.id})` });
    }

    // 在庫チェック（合算qty）
    const needQtyMap = new Map();
    for (const x of normCart) needQtyMap.set(x.id, (needQtyMap.get(x.id) || 0) + x.qty);

    for (const [pid, need] of needQtyMap.entries()) {
      const p = rowMap.get(pid);
      if (Number(p.stock) < need) {
        return res.status(400).json({ error: `在庫不足です: ${p.name}（必要:${need}, 在庫:${p.stock}）` });
      }
    }

    // 合計金額
    const itemsDetailed = normCart.map((x) => {
      const p = rowMap.get(x.id);
      return { id: p.id, name: p.name, price: Number(p.price), qty: x.qty };
    });
    const total = itemsDetailed.reduce((sum, it) => sum + (it.price * it.qty), 0);

    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({ error: "合計金額が不正です" });
    }

    // Squareに支払い作成（JPYは最小単位=円）
    const paymentRequest = {
      idempotencyKey,
      sourceId,
      locationId,
      amountMoney: { amount: BigInt(total), currency: "JPY" },
      buyerEmailAddress: email,
      billingAddress: { addressLine1: address, firstName: name },
    };

    const paymentResponse =
      paymentsMode === "paymentsApi"
        ? await client.paymentsApi.createPayment(paymentRequest)
        : await client.payments.create(paymentRequest);

    const payment =
      paymentResponse.payment ??
      paymentResponse.result?.payment ??
      paymentResponse.body?.payment;

    if (!payment?.id) {
      console.error("Unexpected Square payment response:", paymentResponse);
      return res.status(500).json({ error: "Squareの決済結果を取得できませんでした" });
    }

    // items_json 保存（複数商品でも後で整形可能）
    const itemsJson = JSON.stringify(itemsDetailed);

    // 在庫減算＆購入記録（決済成功後）
    await db.exec("BEGIN IMMEDIATE");
    try {
      // もう一回在庫確認（競合対策）
      for (const [pid, need] of needQtyMap.entries()) {
        const p = await db.get("SELECT * FROM products WHERE id = ?", [pid]);
        if (!p || Number(p.stock) < need) throw new Error(`在庫不足です: ${p?.name || pid}`);
      }

      // qty分だけ減算
      for (const [pid, need] of needQtyMap.entries()) {
        await db.run("UPDATE products SET stock = stock - ? WHERE id = ?", [need, pid]);
      }

      const summary = itemsDetailed.map((it) => `${it.name}¥${it.price}×${it.qty}`).join(" / ");

      await db.run(
        `INSERT INTO payments (amount, description, created_at, method, name, address, phone, email, items_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          total,
          `ORDER: ${summary}`,
          new Date().toISOString(),
          `Square(WebPaymentsSDK) paymentId=${payment.id}`,
          name,
          address,
          phone,
          email,
          itemsJson,
        ]
      );

      await db.exec("COMMIT");
    } catch (e) {
      await db.exec("ROLLBACK");
      throw e;
    }

    // メール（失敗しても決済は成功扱い）
    try {
      await transporter.sendMail({
        from: `"Haku Latte. Order" <${process.env.MAIL_USER}>`,
        to: "info.vfes0220@gmail.com",
        subject: "【Haku Latte.】Square支払いが完了しました",
        text:
          `購入者: ${name}\n` +
          `メール: ${email}\n` +
          `住所: ${address}\n` +
          `電話: ${phone}\n\n` +
          `購入内容:\n- ${itemsDetailed
            .map((it) => `${it.name} ¥${it.price} ×${it.qty}`)
            .join("\n- ")}\n\n` +
          `合計: ¥${total}\n` +
          `決済ID: ${payment.id}\n`,
      });
    } catch (mailErr) {
      console.error("メール送信失敗（決済は成功）:", mailErr);
    }

    return res.json({
      success: true,
      payment: { id: payment.id, status: payment.status },
      order: { items: itemsDetailed, total },
    });
  } catch (err) {
    console.error("Web Payments SDK 決済エラー:", err);
    return res.status(500).json({ error: "決済に失敗しました", details: err.message });
  }
});













// ==============================
// PayPay
// ==============================

const PAYPAY_API_KEY = (process.env.PAYPAY_API_KEY || "").trim();
const PAYPAY_API_SECRET = (process.env.PAYPAY_API_SECRET || "").trim();
const PAYPAY_MERCHANT_ID = (process.env.PAYPAY_MERCHANT_ID || "").trim();
const PAYPAY_BASE_URL =
  process.env.PAYPAY_BASE_URL || "https://stg-api.paypay.ne.jp";

// 認証ヘッダー生成
function createPayPayAuthHeader(method, path, body = "") {
  const nonce = crypto.randomBytes(8).toString("hex");
  const epoch = Math.floor(Date.now() / 1000).toString();

  const hasBody = body && body.length > 0;
  const contentType = hasBody
  ? "application/json"
  : "empty";

  const bodyHash = hasBody
    ? crypto
        .createHash("md5")
        .update(contentType)
        .update(body)
        .digest("base64")
    : "empty";

  const hmacData =
  path + "\n" +
  method + "\n" +
  nonce + "\n" +
  epoch + "\n" +
  contentType + "\n" +
  bodyHash + "\n";

  const signature = crypto
    .createHmac("sha256", PAYPAY_API_SECRET)
    .update(hmacData)
    .digest("base64");

  return `hmac OPA-Auth:${PAYPAY_API_KEY}:${signature}:${nonce}:${epoch}:${bodyHash}`;
}

// ==============================
// PayPay 決済開始
// ==============================

app.post("/paypay/create-payment", async (req, res) => {
  try {
    const { cart, name, address, email, phone } = req.body || {};

    if (!name || !address || !email || !phone) {
      return res.status(400).json({ error: "お届け先情報が不足しています" });
    }

    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: "カートが空です" });
    }

    const db = await dbPromise;

    // 商品取得
    const ids = [...new Set(cart.map((x) => Number(x.id)))];
    const placeholders = ids.map(() => "?").join(",");

    const rows = await db.all(
      `SELECT * FROM products WHERE id IN (${placeholders})`,
      ids
    );

    const rowMap = new Map(rows.map((p) => [p.id, p]));

    let total = 0;

    const itemsDetailed = cart.map((item) => {
      const p = rowMap.get(Number(item.id));

      if (!p) throw new Error("商品が存在しません");

      const qty = Number(item.qty || 1);

      total += Number(p.price) * qty;

      return {
        id: p.id,
        name: p.name,
        price: Number(p.price),
        qty,
      };
    });

    const merchantPaymentId =
      "paypay_" + Date.now() + "_" + Math.floor(Math.random() * 100000);

    const payload = {
      merchantPaymentId,
      codeType: "ORDER_QR",
      amount: {
        amount: total,
        currency: "JPY",
      },
      orderDescription: "Haku Latte. order",
      redirectUrl: `${process.env.BASE_URL}/success.html?paypayOrderId=${merchantPaymentId}`,
      redirectType: "WEB_LINK",
    };

    const body = JSON.stringify(payload);

    const path = "/v2/codes";

    const response = await fetch(
      PAYPAY_BASE_URL + path,
      {
        method: "POST",
        headers: {
          Authorization: createPayPayAuthHeader("POST", path, body),
          "Content-Type": "application/json",
        },
        body,
      }
    );

    // const data = await response.json();

    // console.log("PayPay response:", data);
    const data = await response.json();

    console.log("PayPay status:", response.status);
    console.log("PayPay response full:", JSON.stringify(data, null, 2));




    if (!response.ok) {
      return res.status(500).json(data);
    }



    await db.run(
      `INSERT INTO paypay_pending_orders
      (merchant_payment_id, amount, items_json, name, address, phone, email, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        merchantPaymentId,
        total,
        JSON.stringify(itemsDetailed),
        name,
        address,
        phone,
        email,
        "CREATED",
        new Date().toISOString(),
      ]
    );




    return res.json({
      success: true,
      url: data.data.url,
      merchantPaymentId,
      itemsDetailed,
      total,
    });

  } catch (err) {
    console.error("❌ PayPay create error:", err);

    return res.status(500).json({
      error: err.message,
    });
  }
});










app.post("/paypay/confirm-payment", async (req, res) => {
  try {
    const { merchantPaymentId } = req.body || {};

    if (!merchantPaymentId) {
      return res.status(400).json({ error: "merchantPaymentId がありません" });
    }

    const db = await dbPromise;

    const pending = await db.get(
      "SELECT * FROM paypay_pending_orders WHERE merchant_payment_id = ?",
      [merchantPaymentId]
    );

    if (!pending) {
      return res.status(404).json({ error: "注文情報が見つかりません" });
    }

    if (pending.status === "COMPLETED") {
      return res.json({
        success: true,
        alreadySaved: true,
        order: {
          items: JSON.parse(pending.items_json),
          total: pending.amount,
        },
      });
    }

    const path = `/v2/codes/payments/${merchantPaymentId}`;

    const response = await fetch(PAYPAY_BASE_URL + path, {
      method: "GET",
      headers: {
        Authorization: createPayPayAuthHeader("GET", path),
      },
    });

    const data = await response.json();

    console.log("PayPay confirm status:", response.status);
    console.log("PayPay confirm full:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return res.status(500).json(data);
    }

    const paymentStatus = data?.data?.status;

    if (paymentStatus !== "COMPLETED") {
      return res.status(400).json({
        error: "PayPay支払いが完了していません",
        status: paymentStatus,
      });
    }

    const itemsDetailed = JSON.parse(pending.items_json);
    const total = Number(pending.amount);

    await db.exec("BEGIN IMMEDIATE");

    try {
      for (const it of itemsDetailed) {
        const p = await db.get("SELECT * FROM products WHERE id = ?", [it.id]);

        if (!p || Number(p.stock) < Number(it.qty)) {
          throw new Error(`在庫不足です: ${it.name}`);
        }
      }

      for (const it of itemsDetailed) {
        await db.run(
          "UPDATE products SET stock = stock - ? WHERE id = ?",
          [Number(it.qty), Number(it.id)]
        );
      }

      const summary = itemsDetailed
        .map((it) => `${it.name}¥${it.price}×${it.qty}`)
        .join(" / ");

      await db.run(
        `INSERT INTO payments
         (amount, description, created_at, method, name, address, phone, email, items_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          total,
          `ORDER: ${summary}`,
          new Date().toISOString(),
          `PayPay merchantPaymentId=${merchantPaymentId}`,
          pending.name,
          pending.address,
          pending.phone,
          pending.email,
          pending.items_json,
        ]
      );

      await db.run(
        "UPDATE paypay_pending_orders SET status = ? WHERE merchant_payment_id = ?",
        ["COMPLETED", merchantPaymentId]
      );

      await db.exec("COMMIT");
    } catch (e) {
      await db.exec("ROLLBACK");
      throw e;
    }

    return res.json({
      success: true,
      order: {
        items: itemsDetailed,
        total,
      },
    });
  } catch (err) {
    console.error("❌ PayPay confirm error:", err);
    return res.status(500).json({ error: err.message });
  }
});












// ==============================
// 起動（DB初期化→listen）
// ==============================
async function startServer() {
  await initDb();

  if (isRender) {
    app.listen(PORT, () => console.log(`🚀 Server running on Render (HTTP) port ${PORT}`));
  } else {
    const keyPath = path.resolve("certs/localhost-key.pem");
    const certPath = path.resolve("certs/localhost-cert.pem");

    https
      .createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
      .listen(PORT, () => console.log(`🚀 HTTPS サーバー起動中：https://localhost:${PORT}`));
  }
}

startServer().catch((err) => console.error("❌ Server failed to start:", err));