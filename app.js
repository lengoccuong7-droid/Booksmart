
import * as webllm from "https://esm.run/@mlc-ai/web-llm@0.2.88";
import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

const $ = id => document.getElementById(id);
const DB_NAME = "medical-book-ai";
const STORE = "sessions";

let engine = null;
let pdfFile = null;
let extracted = [];
let translated = [];
let paused = false;
let running = false;

const SYSTEM_PROMPT = `
Bạn là chuyên gia dịch thuật y khoa Anh-Việt.
Dịch đầy đủ, trung thành với nguyên bản.
Không tự thêm, không bỏ ý, không tóm tắt.
Giữ nguyên số liệu, đơn vị, công thức, tên thuốc,
tên riêng và tên nghiệm pháp.
Sử dụng thuật ngữ y khoa tiếng Việt chuẩn.
Giữ nguyên tiêu đề, bảng và danh sách khi có thể.
Nếu không chắc thuật ngữ, ghi chú [cần kiểm tra thuật ngữ].
Chỉ trả về bản dịch tiếng Việt.
`;

function status(id, message) {
  $(id).textContent = message;
}

function bar(id, value) {
  $(id).style.width =
    Math.max(0, Math.min(100, value)) + "%";
}

function setButtons() {
  $("start").disabled = !(pdfFile && engine && !running);
  $("pause").disabled = !running;
  $("testTranslate").disabled = !engine;
  $("export").disabled = translated.length === 0;
}

function errorText(error) {
  return error?.message || String(error);
}

// KIỂM TRA WEBGPU VÀ DANH SÁCH MÔ HÌNH
async function initialize() {
  const supported = !!navigator.gpu;

  status(
    "gpuStatus",
    supported
      ? "WebGPU được phát hiện. Đang kiểm tra mô hình."
      : "Không phát hiện WebGPU. Không thể chạy AI cục bộ."
  );

  if (!supported) {
    $("loadModel").disabled = true;
    return;
  }

  const models = webllm.prebuiltAppConfig?.model_list || [];
  const select = $("modelSelect");

  if (!models.length) {
    status("modelStatus", "Không đọc được danh sách mô hình WebLLM.");
    $("loadModel").disabled = true;
    return;
  }

  const preferred = models.filter(m =>
    /qwen/i.test(m.model_id) &&
    /(0\.5b|0_5b|1\.5b)/i.test(m.model_id)
  );

  const choices = preferred.length ? preferred : models.slice(0, 20);

  select.innerHTML = "";

  choices.forEach(model => {
    const option = document.createElement("option");
    option.value = model.model_id;
    option.textContent = model.model_id;
    select.appendChild(option);
  });

  select.disabled = false;
  $("loadModel").disabled = false;

  status(
    "modelStatus",
    `Đã tìm thấy ${models.length} mô hình.`
  );
}

// TẢI AI
$("loadModel").addEventListener("click", async () => {
  const modelId = $("modelSelect").value;

  if (!navigator.gpu || !modelId) return;

  $("loadModel").disabled = true;

  status("modelStatus", "Đang tải mô hình AI...");

  try {
    const appConfig = {
      ...webllm.prebuiltAppConfig
    };

    if (!appConfig.model_list.some(m => m.model_id === modelId)) {
      throw new Error("Mã mô hình không hợp lệ.");
    }

    engine = await webllm.CreateMLCEngine(modelId, {
      appConfig,
      initProgressCallback: progress => {
        status(
          "modelStatus",
          progress.text || "Đang tải mô hình..."
        );

        bar(
          "modelBar",
          (progress.progress || 0) * 100
        );
      }
    });

    bar("modelBar", 100);

    status(
      "modelStatus",
      "AI đã khởi động. Có thể thử dịch."
    );

  } catch (error) {
    engine = null;

    status(
      "modelStatus",
      "Lỗi tải AI: " + errorText(error)
    );

  } finally {
    $("loadModel").disabled = false;
    setButtons();
  }
});

// CHỌN PDF
$("pdfFile").addEventListener("change", event => {
  pdfFile = event.target.files?.[0] || null;

  $("fileName").textContent = pdfFile
    ? `${pdfFile.name} · ${(pdfFile.size / 1048576).toFixed(1)} MB`
    : "Chưa chọn tài liệu";

  setButtons();
});

// TRÍCH XUẤT PDF
async function extractPDF(file) {
  const bytes = await file.arrayBuffer();

  const document = await pdfjsLib.getDocument({
    data: bytes
  }).promise;

  const pages = [];

  for (let n = 1; n <= document.numPages; n++) {
    const page = await document.getPage(n);
    const content = await page.getTextContent();

    const text = content.items
      .map(item => item.str || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    pages.push({
      page: n,
      text
    });

    $("pageCount").textContent =
      `${n}/${document.numPages} trang đã đọc`;

    status(
      "workStatus",
      `Đang đọc trang ${n}/${document.numPages}`
    );
  }

  return pages;
}

// CHIA ĐOẠN
function makeChunks(pages, maxChars = 1300) {
  const chunks = [];

  let buffer = "";
  let start = 1;
  let end = 1;

  for (const page of pages) {
    if (!page.text) continue;

    const sentences =
      page.text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [page.text];

    for (const sentence of sentences) {
      const part = sentence.trim();

      if (!part) continue;

      if (buffer && buffer.length + part.length > maxChars) {
        chunks.push({
          text: buffer,
          start,
          end
        });

        buffer = "";
      }

      if (!buffer) start = page.page;

      end = page.page;
      buffer += (buffer ? " " : "") + part;
    }
  }

  if (buffer) {
    chunks.push({
      text: buffer,
      start,
      end
    });
  }

  return chunks;
}

// DỊCH Y KHOA
async function translate(text) {
  if (!engine) throw new Error("AI chưa được khởi động.");

  const response = await engine.chat.completions.create({
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT
      },
      {
        role: "user",
        content: "Dịch sang tiếng Việt:\n\n" + text
      }
    ],
    temperature: 0.1,
    top_p: 0.9,
    max_tokens: 1100
  });

  const result =
    response.choices?.[0]?.message?.content?.trim();

  if (!result) throw new Error("AI trả về nội dung rỗng.");

  return result;
}

// HIỂN THỊ BẢN DỊCH
function renderOutput() {
  $("output").textContent = translated.map((item, i) =>
    `[Đoạn ${i + 1} · trang ${item.pageStart}-${item.pageEnd}]\n${item.translation}`
  ).join("\n\n");
}

// LƯU TIẾN ĐỘ
async function saveProgress() {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");

      tx.objectStore(STORE).put({
        translated,
        extracted,
        fileName: pdfFile?.name || ""
      }, "latest");

      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// XỬ LÝ TOÀN BỘ SÁCH
$("start").addEventListener("click", async () => {
  if (!pdfFile || !engine || running) return;

  running = true;
  paused = false;
  setButtons();

  try {
    const pages = await extractPDF(pdfFile);
    extracted = makeChunks(pages);

    $("chunkCount").textContent =
      `${extracted.length} đoạn`;

    if (!extracted.length) {
      throw new Error("PDF không có văn bản để trích xuất.");
    }

    for (let i = translated.length; i < extracted.length; i++) {
      if (paused) break;

      const chunk = extracted[i];

      status(
        "workStatus",
        `Đang dịch đoạn ${i + 1}/${extracted.length}`
      );

      const result = await translate(chunk.text);

      translated.push({
        pageStart: chunk.start,
        pageEnd: chunk.end,
        source: chunk.text,
        translation: result
      });

      renderOutput();

      bar(
        "workBar",
        translated.length / extracted.length * 100
      );

      await saveProgress();
    }

    status(
      "workStatus",
      paused
        ? "Đã tạm dừng."
        : `Hoàn thành ${translated.length}/${extracted.length} đoạn.`
    );

  } catch (error) {
    status(
      "workStatus",
      "Lỗi xử lý: " + errorText(error)
    );

  } finally {
    running = false;
    setButtons();
  }
});

// TẠM DỪNG
$("pause").addEventListener("click", () => {
  paused = true;
  status("workStatus", "Sẽ dừng sau đoạn hiện tại.");
});

// DỊCH THỬ
$("testTranslate").addEventListener("click", async () => {
  const text = $("testText").value.trim();

  if (!text || !engine) return;

  $("testTranslate").disabled = true;

  try {
    const result = await translate(text);

    $("output").textContent = result;

    status(
      "workStatus",
      "Đã dịch thử. Cần kiểm tra chuyên môn."
    );

  } catch (error) {
    status(
      "workStatus",
      "Lỗi dịch: " + errorText(error)
    );

  } finally {
    $("testTranslate").disabled = !engine;
  }
});

// PHIÊN MỚI
$("newSession").addEventListener("click", () => {
  if (running) return;

  translated = [];
  extracted = [];
  paused = false;

  $("output").textContent = "Phiên mới.";
  $("chunkCount").textContent = "0 đoạn";
  $("pageCount").textContent = "0 trang đã đọc";

  bar("workBar", 0);

  status("workStatus", "Đã tạo phiên mới.");
  setButtons();
});

// XUẤT TXT
$("export").addEventListener("click", () => {
  if (!translated.length) return;

  const text = translated.map((item, i) =>
    `ĐOẠN ${i + 1} · TRANG ${item.pageStart}-${item.pageEnd}\n\n${item.translation}`
  ).join("\n\n------------------------\n\n");

  const blob = new Blob(
    ["\uFEFF", text],
    { type: "text/plain;charset=utf-8" }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "medical-book-ai-ban-dich.txt";
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 1500);
});

// KHỞI ĐỘNG
initialize().catch(error => {
  status("modelStatus", "Lỗi khởi tạo: " + errorText(error));
});
