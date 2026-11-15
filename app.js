
import { CreateMLCEngine } from "https://esm.run/@mlc-ai/web-llm@0.2.88";
import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

// ==========================================
// MEDICAL BOOK AI WEB
// Version 1.0 - Browser AI
// ==========================================

const $ = id => document.getElementById(id);

const DB_NAME = "medical-book-ai";
const STORE = "sessions";
const MODEL_ID = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";

let engine = null;
let pdfFile = null;
let extracted = [];
let translated = [];
let paused = false;
let running = false;
let dbPromise = null;

const SYSTEM_PROMPT = `
Bạn là chuyên gia dịch thuật y khoa Anh - Việt.

NHIỆM VỤ:
- Dịch đầy đủ, trung thành với nguyên bản.
- Không tự thêm, không bỏ ý, không tóm tắt.
- Không tự suy diễn nội dung chuyên môn.
- Giữ nguyên số liệu, đơn vị, công thức và tên thuốc.
- Giữ tên riêng và tên nghiệm pháp khi cần thiết.
- Sử dụng thuật ngữ y khoa tiếng Việt chuẩn.
- Giữ cấu trúc tiêu đề, danh sách và nội dung bảng khi có thể.
- Không biến nội dung mô tả thành lời khuyên điều trị.
- Nếu không chắc thuật ngữ, ghi [CẦN KIỂM TRA THUẬT NGỮ].
- Chỉ trả về bản dịch tiếng Việt.
`;

function status(id, message) {
  const element = $(id);
  if (element) element.textContent = message;
}

function bar(id, value) {
  const element = $(id);
  if (element) {
    element.style.width =
      Math.max(0, Math.min(100, value)) + "%";
  }
}

function errorText(error) {
  return error?.message || String(error);
}

function setButtons() {
  if ($("start")) {
    $("start").disabled =
      !(pdfFile && engine && !running);
  }

  if ($("pause")) {
    $("pause").disabled = !running;
  }

  if ($("testTranslate")) {
    $("testTranslate").disabled = !engine;
  }

  if ($("export")) {
    $("export").disabled = translated.length === 0;
  }
}

// ==========================================
// KIỂM TRA THIẾT BỊ
// ==========================================

async function initialize() {
  status("gpuStatus", "Đang kiểm tra WebGPU...");

  if (!navigator.gpu) {
    status("gpuStatus", "Không phát hiện WebGPU.");
    status("modelStatus", "Thiết bị chưa hỗ trợ WebGPU.");

    if ($("loadModel")) {
      $("loadModel").disabled = true;
    }
    return;
  }

  status("gpuStatus", "Đã phát hiện WebGPU.");

  // Không bắt buộc phải có modelSelect trong HTML
  if ($("modelSelect")) {
    $("modelSelect").innerHTML = "";

    const option = document.createElement("option");
    option.value = MODEL_ID;
    option.textContent = "Qwen 2.5 0.5B - bản nhẹ";

    $("modelSelect").appendChild(option);
    $("modelSelect").disabled = false;
  }

  if ($("loadModel")) {
    $("loadModel").disabled = false;
  }

  status(
    "modelStatus",
    "Đã chọn Qwen 0.5B. Sẵn sàng tải mô hình."
  );
}
// ==========================================
// TẢI MÔ HÌNH AI
// ==========================================

async function loadAI() {
  if (!navigator.gpu) {
    status("modelStatus", "WebGPU không khả dụng.");
    return;
  }

  if (engine) {
    status("modelStatus", "AI đã được khởi động.");
    return;
  }

  $("loadModel").disabled = true;

  status(
    "modelStatus",
    "Đang khởi tạo mô hình AI..."
  );

  bar("modelBar", 0);

  try {
    engine = await CreateMLCEngine(MODEL_ID, {
      initProgressCallback: progress => {
        const message =
          progress?.text || "Đang tải mô hình AI...";

        status("modelStatus", message);

        const percent =
          Number(progress?.progress || 0) * 100;

        bar("modelBar", percent);
      }
    });

    bar("modelBar", 100);

    status(
      "modelStatus",
      "AI đã khởi động thành công. Có thể dịch thử."
    );

  } catch (error) {
    engine = null;

    console.error("WebLLM error:", error);

    status(
      "modelStatus",
      "Không tải được AI: " + errorText(error)
    );

    bar("modelBar", 0);

  } finally {
    $("loadModel").disabled = false;
    setButtons();
  }
}

if ($("loadModel")) {
  $("loadModel").addEventListener("click", loadAI);
}

// ==========================================
// CHỌN FILE PDF
// ==========================================

if ($("pdfFile")) {
  $("pdfFile").addEventListener("change", event => {
    pdfFile = event.target.files?.[0] || null;

    if ($("fileName")) {
      $("fileName").textContent = pdfFile
        ? `${pdfFile.name} · ${(pdfFile.size / 1048576).toFixed(1)} MB`
        : "Chưa chọn tài liệu";
    }

    setButtons();
  });
}

// ==========================================
// ĐỌC NỘI DUNG PDF
// ==========================================

async function extractPDF(file) {
  const bytes = await file.arrayBuffer();

  const document = await pdfjsLib.getDocument({
    data: bytes
  }).promise;

  const pages = [];

  for (let n = 1; n <= document.numPages; n++) {
    if (paused) break;

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

    status(
      "workStatus",
      `Đang đọc trang ${n}/${document.numPages}`
    );

    if ($("pageCount")) {
      $("pageCount").textContent =
        `${n}/${document.numPages} trang đã đọc`;
    }
  }

  return pages;
}

// ==========================================
// CHIA VĂN BẢN THÀNH ĐOẠN
// ==========================================

function makeChunks(pages, maxChars = 1300) {
  const chunks = [];

  let buffer = "";
  let start = 1;
  let end = 1;

  for (const page of pages) {
    if (!page.text) continue;

    const sentences =
      page.text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)
      || [page.text];

    for (const sentence of sentences) {
      const part = sentence.trim();

      if (!part) continue;

      if (
        buffer &&
        buffer.length + part.length > maxChars
      ) {
        chunks.push({
          text: buffer,
          start,
          end
        });

        buffer = "";
      }

      if (!buffer) start = page.page;

      end = page.page;

      buffer +=
        (buffer ? " " : "") + part;
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

// ==========================================
// DỊCH Y KHOA
// ==========================================

async function translate(text) {
  if (!engine) {
    throw new Error("AI chưa được khởi động.");
  }

  const response =
    await engine.chat.completions.create({
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT
        },
        {
          role: "user",
          content:
            "Dịch đầy đủ nội dung sau sang tiếng Việt:\n\n"
            + text
        }
      ],

      temperature: 0.1,
      top_p: 0.9,
      max_tokens: 1100
    });

  const result =
    response.choices?.[0]?.message?.content?.trim();

  if (!result) {
    throw new Error("AI trả về nội dung rỗng.");
  }

  return result;
}

// ==========================================
// HIỂN THỊ BẢN DỊCH
// ==========================================

function renderOutput() {
  if (!$("output")) return;

  $("output").textContent =
    translated.map((item, i) =>
      `[Đoạn ${i + 1} · trang ${item.pageStart}-${item.pageEnd}]\n\n${item.translation}`
    ).join("\n\n------------------------\n\n");
}

// ==========================================
// CƠ SỞ DỮ LIỆU LƯU TIẾN ĐỘ
// ==========================================

function openDatabase() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);

    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });

  return dbPromise;
}

async function saveProgress() {
  const db = await openDatabase();

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");

    tx.objectStore(STORE).put({
      translated,
      extracted,
      fileName: pdfFile?.name || "",
      savedAt: new Date().toISOString()
    }, "latest");

    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ==========================================
// KHÔI PHỤC TIẾN ĐỘ ĐÃ LƯU
// ==========================================

async function restoreProgress() {
  try {
    const db = await openDatabase();

    const saved = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request =
        tx.objectStore(STORE).get("latest");

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (!saved) {
      status("workStatus", "Chưa có tiến độ đã lưu.");
      return;
    }

    extracted = saved.extracted || [];
    translated = saved.translated || [];

    renderOutput();

    if ($("chunkCount")) {
      $("chunkCount").textContent =
        `${extracted.length} đoạn`;
    }

    bar(
      "workBar",
      extracted.length
        ? translated.length / extracted.length * 100
        : 0
    );

    status(
      "workStatus",
      `Đã khôi phục ${translated.length}/${extracted.length} đoạn. Chọn lại PDF cũ để tiếp tục.`
    );

    setButtons();

  } catch (error) {
    console.error("Restore error:", error);

    status(
      "workStatus",
      "Không khôi phục được tiến độ: " + errorText(error)
    );
  }
}

// ==========================================
// DỊCH TOÀN BỘ SÁCH
// ==========================================

if ($("start")) {
  $("start").addEventListener("click", async () => {
    if (!pdfFile || !engine || running) return;

    running = true;
    paused = false;

    setButtons();

    try {
      const pages = await extractPDF(pdfFile);

      if (paused) {
        status("workStatus", "Đã tạm dừng khi đọc PDF.");
        return;
      }

      extracted = makeChunks(pages);

      if ($("chunkCount")) {
        $("chunkCount").textContent =
          `${extracted.length} đoạn`;
      }

      if (!extracted.length) {
        throw new Error(
          "Không tìm thấy văn bản có thể đọc trong PDF. Có thể đây là PDF dạng ảnh cần OCR."
        );
      }

      if (
        translated.length > extracted.length
      ) {
        translated = [];
      }

      for (
        let i = translated.length;
        i < extracted.length;
        i++
      ) {
        if (paused) break;

        const chunk = extracted[i];

        status(
          "workStatus",
          `Đang dịch đoạn ${i + 1}/${extracted.length} · trang ${chunk.start}-${chunk.end}`
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
          ? `Đã tạm dừng. Đã dịch ${translated.length}/${extracted.length} đoạn.`
          : `Hoàn thành ${translated.length}/${extracted.length} đoạn.`
      );

    } catch (error) {
      console.error("Processing error:", error);

      status(
        "workStatus",
        "Lỗi xử lý: " + errorText(error)
      );

    } finally {
      running = false;
      setButtons();
    }
  });
}

// ==========================================
// TẠM DỪNG
// ==========================================

if ($("pause")) {
  $("pause").addEventListener("click", () => {
    paused = true;

    status(
      "workStatus",
      "Đang chờ hoàn tất đoạn dịch hiện tại để dừng."
    );
  });
}

// ==========================================
// DỊCH THỬ
// ==========================================

if ($("testTranslate")) {
  $("testTranslate").addEventListener(
    "click",
    async () => {
      const text =
        $("testText")?.value.trim() || "";

      if (!text || !engine) return;

      $("testTranslate").disabled = true;

      try {
        status(
          "workStatus",
          "AI đang dịch thử..."
        );

        const result = await translate(text);

        if ($("output")) {
          $("output").textContent = result;
        }

        status(
          "workStatus",
          "Đã dịch thử. Cần kiểm tra độ chính xác chuyên môn."
        );

      } catch (error) {
        status(
          "workStatus",
          "Lỗi dịch: " + errorText(error)
        );

      } finally {
        $("testTranslate").disabled = !engine;
      }
    }
  );
}

// ==========================================
// PHIÊN MỚI
// ==========================================

if ($("newSession")) {
  $("newSession").addEventListener("click", async () => {
    if (running) return;

    translated = [];
    extracted = [];
    paused = false;

    if ($("output")) {
      $("output").textContent = "Phiên mới.";
    }

    if ($("chunkCount")) {
      $("chunkCount").textContent = "0 đoạn";
    }

    if ($("pageCount")) {
      $("pageCount").textContent = "0 trang đã đọc";
    }

    bar("workBar", 0);

    try {
      const db = await openDatabase();

      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");

        tx.objectStore(STORE).delete("latest");

        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });

    } catch (error) {
      console.error("Clear session error:", error);
    }

    status("workStatus", "Đã tạo phiên mới.");
    setButtons();
  });
}

// ==========================================
// XUẤT BẢN DỊCH TXT
// ==========================================

if ($("export")) {
  $("export").addEventListener("click", () => {
    if (!translated.length) return;

    const text = translated.map((item, i) =>
      `ĐOẠN ${i + 1} · TRANG ${item.pageStart}-${item.pageEnd}\n\n${item.translation}`
    ).join("\n\n------------------------\n\n");

    const blob = new Blob(
      ["\uFEFF", text],
      {
        type: "text/plain;charset=utf-8"
      }
    );

    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");

    link.href = url;
    link.download = "medical-book-ai-ban-dich.txt";

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 2000);
  });
}

// ==========================================
// KHỞI ĐỘNG ỨNG DỤNG
// ==========================================

async function startApplication() {
  try {
    await initialize();
    await restoreProgress();

    status(
      "workStatus",
      "Ứng dụng đã sẵn sàng. Hãy tải AI trước khi dịch sách."
    );

  } catch (error) {
    console.error("Application error:", error);

    status(
      "modelStatus",
      "Lỗi khởi động: " + errorText(error)
    );
  }

  setButtons();
}

startApplication();
