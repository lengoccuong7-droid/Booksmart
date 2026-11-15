import { CreateMLCEngine } from "https://esm.run/@mlc-ai/web-llm@0.2.88";
import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

// MEDICAL BOOK AI - xử lý theo lô 10 trang, dịch từng đoạn nhỏ để phù hợp iPhone.
const $ = id => document.getElementById(id);
const DB_NAME = "medical-book-ai";
const STORE = "sessions";
const MODEL_ID = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
const PAGES_PER_BATCH = 10;
const MAX_INPUT_CHARS = 650;
const MAX_OUTPUT_TOKENS = 900;

let engine = null;
let pdfFile = null;
let extracted = [];
let translated = [];
let paused = false;
let running = false;
let dbPromise = null;
let activeFileKey = "";

const SYSTEM_PROMPT = `Bạn là công cụ dịch thuật Anh-Việt chuyên ngành y học và phục hồi chức năng.
YÊU CẦU BẮT BUỘC:
- Chỉ dịch phần văn bản tiếng Anh được cung cấp sang tiếng Việt.
- Dịch trung thành, không tóm tắt, không tự thêm kiến thức hoặc câu không có trong nguồn.
- Giữ nguyên số liệu, đơn vị, ký hiệu, tên thuốc, tên tác giả, tên tài liệu và chữ viết tắt chuyên ngành khi cần.
- Dùng thuật ngữ y khoa tiếng Việt thông dụng, chính xác; có thể giữ thuật ngữ tiếng Anh trong ngoặc khi cần phân biệt.
- Giữ tiêu đề, thứ tự và cấu trúc đoạn ở mức có thể.
- Bỏ qua chuỗi ký tự vô nghĩa do lỗi nhận dạng PDF; tuyệt đối không lặp từ/cụm từ để lấp chỗ trống.
- Không đoán phần chữ bị mất hoặc không đọc được. Đánh dấu [KHÔNG ĐỌC RÕ] nếu nguồn thực sự không rõ.
- Chỉ trả về bản dịch, không nhắc lại yêu cầu và không viết lời dẫn.`;

function status(id, message) {
  const el = $(id);
  if (el) el.textContent = message;
}
function bar(id, value) {
  const el = $(id);
  if (el) el.style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
}
function errorText(error) { return error?.message || String(error); }
function setButtons() {
  if ($("start")) $("start").disabled = !(pdfFile && engine && !running);
  if ($("pause")) $("pause").disabled = !running;
  if ($("testTranslate")) $("testTranslate").disabled = !engine || running;
  if ($("export")) $("export").disabled = translated.length === 0;
  if ($("loadModel")) $("loadModel").disabled = running || !!engine;
}
function fileKey(file) {
  return file ? `${file.name}|${file.size}|${file.lastModified}` : "";
}

async function initialize() {
  status("gpuStatus", "Đang kiểm tra WebGPU...");
  if (!navigator.gpu) {
    status("gpuStatus", "Không phát hiện WebGPU trên trình duyệt này.");
    status("modelStatus", "Thiết bị chưa hỗ trợ WebGPU để chạy AI cục bộ.");
    if ($("loadModel")) $("loadModel").disabled = true;
    return;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("Không tìm thấy bộ xử lý đồ họa tương thích.");
    status("gpuStatus", "WebGPU sẵn sàng.");
    if ($("loadModel")) $("loadModel").disabled = false;
    status("modelStatus", "Sẵn sàng tải Qwen2.5 0.5B (mô hình thử nghiệm).");
  } catch (error) {
    status("gpuStatus", "Không khởi tạo được WebGPU: " + errorText(error));
    status("modelStatus", "Không thể chạy AI cục bộ trên thiết bị này.");
    if ($("loadModel")) $("loadModel").disabled = true;
  }
}

async function loadAI() {
  if (!navigator.gpu || engine || running) return;
  if ($("loadModel")) $("loadModel").disabled = true;
  status("modelStatus", "Đang tải mô hình AI lần đầu; vui lòng giữ trang mở...");
  bar("modelBar", 0);
  try {
    engine = await CreateMLCEngine(MODEL_ID, {
      initProgressCallback: p => {
        status("modelStatus", p?.text || "Đang tải mô hình...");
        bar("modelBar", (Number(p?.progress) || 0) * 100);
      }
    });
    bar("modelBar", 100);
    status("modelStatus", "AI đã tải xong. Có thể dịch thử hoặc xử lý sách.");
  } catch (error) {
    engine = null;
    console.error(error);
    status("modelStatus", "Không tải được mô hình: " + errorText(error));
    bar("modelBar", 0);
  }
  setButtons();
}
if ($("loadModel")) $("loadModel").addEventListener("click", loadAI);

if ($("pdfFile")) {
  $("pdfFile").addEventListener("change", async event => {
    pdfFile = event.target.files?.[0] || null;
    activeFileKey = fileKey(pdfFile);
    if ($("fileName")) $("fileName").textContent = pdfFile
      ? `${pdfFile.name} · ${(pdfFile.size / 1048576).toFixed(1)} MB`
      : "Chưa chọn tài liệu";
    if (pdfFile) {
      const saved = await readSaved().catch(() => null);
      const sameSavedFile = saved && (
        saved.fileKey === activeFileKey || (!saved.fileKey && saved.fileName === pdfFile.name)
      );
      if (sameSavedFile && Array.isArray(saved.extracted)) {
        extracted = saved.extracted;
        translated = (saved.translated || []).map((item, index) => ({
          ...item,
          chunkIndex: Number.isInteger(item.chunkIndex) ? item.chunkIndex : index,
          pageStart: item.pageStart ?? item.start ?? 1,
          pageEnd: item.pageEnd ?? item.end ?? item.pageStart ?? item.start ?? 1
        }));
        renderOutput();
        updateProgress();
        status("workStatus", `Đã khôi phục ${translated.length}/${extracted.length} đoạn của tài liệu này. Có thể tiếp tục.`);
      } else {
        extracted = [];
        translated = [];
        renderOutput();
        updateProgress();
        status("workStatus", "Đã chọn PDF mới. Nhấn BẮT ĐẦU XỬ LÝ TỰ ĐỘNG.");
      }
    }
    setButtons();
  });
}

function cleanPdfText(text) {
  return String(text || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
async function extractPDF(file) {
  const data = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    if (paused) break;
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const text = cleanPdfText(content.items.map(item => item.str || "").join(" "));
    pages.push({ page: n, text });
    if ($("pageCount")) $("pageCount").textContent = `${n}/${doc.numPages} trang đã đọc`;
    status("workStatus", `Đang đọc PDF: trang ${n}/${doc.numPages}`);
    if (n % PAGES_PER_BATCH === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { pages, totalPages: doc.numPages };
}

// Chia trong từng trang để không làm mất mốc trang; mỗi lô xử lý đúng tối đa 10 trang.
function splitText(text, maxChars = MAX_INPUT_CHARS) {
  const paragraphs = String(text || "").split(/(?<=[.!?;:])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  const pieces = [];
  let buffer = "";
  for (const para of paragraphs.length ? paragraphs : [String(text || "")]) {
    if (para.length > maxChars) {
      if (buffer) { pieces.push(buffer); buffer = ""; }
      for (let i = 0; i < para.length; i += maxChars) pieces.push(para.slice(i, i + maxChars));
    } else if (!buffer) buffer = para;
    else if ((buffer + " " + para).length <= maxChars) buffer += " " + para;
    else { pieces.push(buffer); buffer = para; }
  }
  if (buffer) pieces.push(buffer);
  return pieces;
}
function makeChunks(pages) {
  const chunks = [];
  for (const page of pages) {
    if (!page.text) continue;
    for (const part of splitText(page.text)) {
      chunks.push({ text: part, start: page.page, end: page.page });
    }
  }
  return chunks;
}

function looksCorrupt(source, result) {
  const s = result.toLowerCase().replace(/\s+/g, " ").trim();
  if (s.length < 12) return "Kết quả quá ngắn";
  if (/(.{2,35})\1{3,}/i.test(s)) return "Có dấu hiệu lặp cụm từ";
  const words = s.split(/\s+/);
  if (words.length > 35) {
    const counts = new Map();
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    const repeated = [...counts.values()].some(n => n / words.length > 0.35);
    if (repeated) return "Một từ xuất hiện bất thường";
  }
  if (result.includes("Dịch đầy đủ nội dung sau") || result.includes("As an AI")) return "AI lặp lại chỉ dẫn";
  if (source.length > 80 && result.length < source.length * 0.12) return "Bản dịch ngắn bất thường so với nguồn";
  return "";
}
async function translate(text) {
  if (!engine) throw new Error("AI chưa được tải.");
  const response = await engine.chat.completions.create({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Dịch phần văn bản nguồn sau sang tiếng Việt. Không thêm nội dung ngoài nguồn.\n\n${text}` }
    ],
    temperature: 0.05,
    top_p: 0.85,
    max_tokens: MAX_OUTPUT_TOKENS
  });
  const result = response.choices?.[0]?.message?.content?.trim();
  if (!result) throw new Error("AI trả về nội dung rỗng.");
  return result;
}

function renderOutput() {
  if (!$("output")) return;
  $("output").textContent = translated.map((item, i) =>
    `[Đoạn ${i + 1} · trang ${item.pageStart}]
${item.warning ? "[CẦN KIỂM TRA: " + item.warning + "]\n" : ""}${item.translation}`
  ).join("\n\n------------------------\n\n");
}
function updateProgress() {
  if ($("chunkCount")) $("chunkCount").textContent = `${extracted.length} đoạn`;
  const done = translated.length;
  const total = extracted.length;
  bar("workBar", total ? done / total * 100 : 0);
  if ($("export")) $("export").disabled = done === 0;
}

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { dbPromise = null; reject(request.error); };
  });
  return dbPromise;
}
async function readSaved() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get("latest");
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function saveProgress() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({
      extracted, translated, fileKey: activeFileKey,
      fileName: pdfFile?.name || "", savedAt: new Date().toISOString()
    }, "latest");
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
async function restoreProgress() {
  try {
    const saved = await readSaved();
    if (!saved) { status("workStatus", "Chưa có tiến độ đã lưu."); return; }
    // Chỉ khôi phục bản dịch; cần chọn lại đúng PDF để tiếp tục.
    extracted = saved.extracted || [];
    // Tương thích dữ liệu đã lưu từ phiên bản trước (chưa có chunkIndex).
    translated = (saved.translated || []).map((item, index) => ({
      ...item,
      chunkIndex: Number.isInteger(item.chunkIndex) ? item.chunkIndex : index,
      pageStart: item.pageStart ?? item.start ?? 1,
      pageEnd: item.pageEnd ?? item.end ?? item.pageStart ?? item.start ?? 1
    }));
    activeFileKey = saved.fileKey || "";
    renderOutput();
    updateProgress();
    status("workStatus", `Đã khôi phục ${translated.length}/${extracted.length} đoạn. Hãy chọn lại đúng PDF để tiếp tục.`);
  } catch (error) { status("workStatus", "Không khôi phục được: " + errorText(error)); }
}

async function processBook() {
  if (!pdfFile || !engine || running) return;
  running = true;
  paused = false;
  setButtons();
  try {
    // Nếu đã khôi phục đúng file và đã có danh sách đoạn thì dùng lại, không đọc lại PDF.
    if (!extracted.length || activeFileKey !== fileKey(pdfFile)) {
      translated = [];
      status("workStatus", "Đang đọc và lập danh sách trang của PDF...");
      const result = await extractPDF(pdfFile);
      if (paused) { status("workStatus", "Đã tạm dừng khi đọc PDF."); return; }
      extracted = makeChunks(result.pages);
      activeFileKey = fileKey(pdfFile);
      if (!extracted.length) throw new Error("Không trích xuất được văn bản. PDF có thể là bản scan cần OCR.");
      await saveProgress();
    }
    const totalChunks = extracted.length;
    const totalPages = Math.max(...extracted.map(c => c.end), 1);
    const completed = new Set(translated.map(t => t.chunkIndex));
    let currentBatch = -1;
    for (let i = 0; i < totalChunks; i++) {
      if (paused) break;
      if (completed.has(i)) continue;
      const chunk = extracted[i];
      const batch = Math.floor((chunk.start - 1) / PAGES_PER_BATCH);
      if (batch !== currentBatch) {
        currentBatch = batch;
        const firstPage = batch * PAGES_PER_BATCH + 1;
        const lastPage = Math.min(firstPage + PAGES_PER_BATCH - 1, totalPages);
        status("workStatus", `Đang xử lý lô ${batch + 1} · trang ${firstPage}-${lastPage} (tối đa 10 trang/lượt)`);
      } else {
        status("workStatus", `Lô ${batch + 1}: đang dịch đoạn ${i + 1}/${totalChunks} · trang ${chunk.start}`);
      }
      const result = await translate(chunk.text);
      const warning = looksCorrupt(chunk.text, result);
      translated.push({ chunkIndex: i, pageStart: chunk.start, pageEnd: chunk.end, source: chunk.text, translation: result, warning });
      translated.sort((a, b) => a.chunkIndex - b.chunkIndex);
      renderOutput();
      updateProgress();
      // Lưu ngay sau mỗi đoạn; nếu Safari đóng tab, phần đã dịch vẫn còn.
      await saveProgress();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    status("workStatus", paused
      ? `Đã tạm dừng. Đã dịch ${translated.length}/${totalChunks} đoạn.`
      : `Đã xử lý xong ${translated.length}/${totalChunks} đoạn thuộc ${totalPages} trang.`);
  } catch (error) {
    console.error("Processing error:", error);
    status("workStatus", "Lỗi xử lý: " + errorText(error));
  } finally {
    running = false;
    setButtons();
  }
}
if ($("start")) $("start").addEventListener("click", processBook);
if ($("pause")) $("pause").addEventListener("click", () => {
  paused = true;
  status("workStatus", "Đang dừng sau khi hoàn tất đoạn dịch hiện tại...");
});

if ($("testTranslate")) $("testTranslate").addEventListener("click", async () => {
  const text = $("testText")?.value?.trim() || "";
  if (!text || !engine || running) return;
  $("testTranslate").disabled = true;
  try {
    status("workStatus", "Đang dịch thử...");
    const result = await translate(text);
    if ($("output")) $("output").textContent = result;
    const warning = looksCorrupt(text, result);
    status("workStatus", warning ? `Dịch thử xong nhưng cần kiểm tra: ${warning}.` : "Dịch thử xong. Vẫn cần bác sĩ kiểm tra thuật ngữ.");
  } catch (error) { status("workStatus", "Lỗi dịch thử: " + errorText(error)); }
  finally { setButtons(); }
});

if ($("newSession")) $("newSession").addEventListener("click", async () => {
  if (running) return;
  translated = [];
  extracted = [];
  paused = false;
  activeFileKey = "";
  if ($("output")) $("output").textContent = "Phiên mới. Hãy chọn PDF.";
  if ($("pageCount")) $("pageCount").textContent = "0 trang đã đọc";
  updateProgress();
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete("latest");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    status("workStatus", "Đã tạo phiên mới và xóa tiến độ cũ.");
  } catch (error) { status("workStatus", "Không xóa được phiên cũ: " + errorText(error)); }
  setButtons();
});

if ($("export")) $("export").addEventListener("click", () => {
  if (!translated.length) return;
  const text = translated.slice().sort((a, b) => a.chunkIndex - b.chunkIndex).map((item, i) =>
    `ĐOẠN ${i + 1} · TRANG ${item.pageStart}\n${item.warning ? "CẦN KIỂM TRA: " + item.warning + "\n" : ""}\n${item.translation}`
  ).join("\n\n----------------------------------------\n\n");
  const blob = new Blob(["\uFEFF", text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "medical-book-ai-ban-dich.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
});

async function startApplication() {
  await initialize();
  await restoreProgress();
  if (!extracted.length) status("workStatus", "Ứng dụng sẵn sàng. Tải AI, chọn PDF rồi bắt đầu xử lý.");
  setButtons();
}
startApplication().catch(error => {
  console.error(error);
  status("workStatus", "Lỗi khởi động: " + errorText(error));
});
