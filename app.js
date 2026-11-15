import * as webllm from "https://esm.run/@mlc-ai/web-llm@0.2.88";
import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

const $ = id => document.getElementById(id);
let engine=null, pdfFile=null, extracted=[], translated=[], paused=false, running=false;
const MODEL_ID="Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
const DB_NAME="medical-book-ai-mvp";
const setStatus=(id,msg)=>$(id).textContent=msg;
const setBar=(id,p)=>$(id).style.width=Math.max(0,Math.min(100,p))+"%";

async function checkGPU(){
  const ok=!!navigator.gpu;
  setStatus("gpuStatus",ok
    ? "WebGPU có sẵn trong trình duyệt này. Cần tải mô hình để kiểm tra khả năng cấp phát bộ nhớ."
    : "Không phát hiện WebGPU. AI cục bộ theo cấu hình hiện tại không thể khởi chạy trong trình duyệt này.");
  $("loadModel").disabled=!ok;
}
checkGPU();

$("pdfFile").addEventListener("change",e=>{
  pdfFile=e.target.files?.[0]||null;
  $("fileName").textContent=pdfFile?`${pdfFile.name} · ${(pdfFile.size/1024/1024).toFixed(1)} MB`:"Chưa chọn tài liệu";
  $("start").disabled=!(pdfFile&&engine);
});

$("loadModel").addEventListener("click",async()=>{
  $("loadModel").disabled=true;
  setStatus("modelStatus","Đang tải mô hình. Lần đầu có thể cần tải vài trăm MB và mất nhiều thời gian…");
  try{
    engine=await webllm.CreateMLCEngine(MODEL_ID,{
      initProgressCallback:p=>{
        setStatus("modelStatus",p.text||"Đang tải mô hình…");
        setBar("modelBar",(p.progress||0)*100);
      },
      appConfig:{cacheBackend:"indexeddb"}
    });
    setStatus("modelStatus","Mô hình đã nạp trong phiên trình duyệt. Hãy chạy phép thử dịch ngắn trước.");
    setBar("modelBar",100);
    $("testTranslate").disabled=false;
    $("start").disabled=!pdfFile;
  }catch(err){
    setStatus("modelStatus","Không nạp được mô hình: "+(err?.message||String(err))+". Có thể do WebGPU, bộ nhớ thiết bị hoặc mô hình không tương thích.");
    $("loadModel").disabled=false;
  }
});

$("newSession").addEventListener("click",async()=>{
  translated=[]; extracted=[]; paused=false; running=false;
  $("output").textContent="Phiên mới. Chưa có bản dịch.";
  setBar("workBar",0); setStatus("workStatus","Đã tạo phiên mới.");
});

async function extractPDF(file){
  const bytes=await file.arrayBuffer();
  const doc=await pdfjsLib.getDocument({data:bytes}).promise;
  const pages=[];
  for(let n=1;n<=doc.numPages;n++){
    const page=await doc.getPage(n);
    const content=await page.getTextContent();
    const text=content.items.map(x=>x.str).join(" ").replace(/\s+/g," ").trim();
    pages.push({page:n,text});
    $("pageCount").textContent=`${n}/${doc.numPages} trang đã đọc`;
    setStatus("workStatus",`Đang trích xuất trang ${n}/${doc.numPages}…`);
  }
  return pages;
}
function makeChunks(pages,maxChars=1600){
  const chunks=[]; let buf="", start=1, end=1;
  for(const p of pages){
    if(!p.text) continue;
    const sentences=p.text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)||[p.text];
    for(const sentence of sentences){
      const s=sentence.trim(); if(!s) continue;
      if((buf+" "+s).length>maxChars && buf){
        chunks.push({text:buf.trim(),start,end}); buf="";
      }
      if(!buf) start=p.page;
      end=p.page; buf+=" "+s;
    }
  }
  if(buf.trim()) chunks.push({text:buf.trim(),start,end});
  return chunks;
}
async function translate(text){
  const response=await engine.chat.completions.create({
    messages:[
      {role:"system",content:"Bạn là trợ lý dịch thuật y khoa Anh-Việt. Dịch trung thành với nguyên bản. Không tự thêm, không bỏ ý. Giữ nguyên số liệu, đơn vị, tên thuốc, tên nghiệm pháp. Dùng thuật ngữ y khoa tiếng Việt chuẩn. Nếu không chắc thuật ngữ, ghi chú [cần kiểm tra thuật ngữ], không đoán."},
      {role:"user",content:"Dịch đoạn sau sang tiếng Việt:\n\n"+text}
    ],
    temperature:0.1,max_tokens:900
  });
  return response.choices?.[0]?.message?.content?.trim()||"";
}
$("testTranslate").addEventListener("click",async()=>{
  const text=$("testText").value.trim(); if(!text||!engine)return;
  $("testTranslate").disabled=true;
  setStatus("workStatus","Đang dịch thử…");
  try{
    const out=await translate(text);
    $("output").textContent=out;
    setStatus("workStatus","Đã hoàn tất phép thử ngắn. Cần người có chuyên môn kiểm tra chất lượng.");
  }catch(e){setStatus("workStatus","Lỗi dịch thử: "+(e?.message||String(e)));}
  $("testTranslate").disabled=false;
});
$("start").addEventListener("click",async()=>{
  if(!pdfFile||!engine||running)return;
  running=true;paused=false;$("pause").disabled=false;$("start").disabled=true;
  try{
    const pages=await extractPDF(pdfFile);
    extracted=makeChunks(pages);
    $("chunkCount").textContent=`${extracted.length} đoạn`;
    if(!extracted.length) throw new Error("Không trích xuất được văn bản. Có thể PDF là bản scan cần OCR.");
    for(let i=translated.length;i<extracted.length;i++){
      if(paused) break;
      setStatus("workStatus",`Đang dịch đoạn ${i+1}/${extracted.length} (trang ${extracted[i].start}–${extracted[i].end})…`);
      const out=await translate(extracted[i].text);
      translated.push({pageStart:extracted[i].start,pageEnd:extracted[i].end,source:extracted[i].text,translation:out});
      await saveProgress();
      $("output").textContent=translated.map((x,j)=>`[Đoạn ${j+1} · trang ${x.pageStart}-${x.pageEnd}]\n${x.translation}`).join("\n\n");
      setBar("workBar",translated.length/extracted.length*100);
    }
    setStatus("workStatus",paused?"Đã tạm dừng. Có thể tiếp tục trong phiên hiện tại.":`Đã xử lý ${translated.length}/${extracted.length} đoạn. Bản thử nghiệm cần rà soát thủ công.`);
    $("export").disabled=!translated.length;
  }catch(e){setStatus("workStatus","Không thể xử lý: "+(e?.message||String(e)));}
  running=false;$("pause").disabled=true;$("start").disabled=!(pdfFile&&engine);
});
$("pause").addEventListener("click",()=>{paused=true;setStatus("workStatus","Đang dừng sau khi hoàn tất đoạn hiện tại…");});
async function saveProgress(){
  try{
    const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open(DB_NAME,1);
      r.onupgradeneeded=()=>r.result.createObjectStore("progress");
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
    await new Promise((resolve,reject)=>{
      const tx=db.transaction("progress","readwrite");
      tx.objectStore("progress").put(translated,"latest");
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    }); db.close();
  }catch(e){console.warn("Không lưu được tiến độ",e);}
}
$("export").addEventListener("click",()=>{
  const text=translated.map((x,i)=>`ĐOẠN ${i+1} · TRANG ${x.pageStart}-${x.pageEnd}\n\n${x.translation}`).join("\n\n--------------------------------\n\n");
  const blob=new Blob([text],{type:"text/plain;charset=utf-8"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="medical-book-ai-ban-dich.txt";a.click();URL.revokeObjectURL(a.href);
});
