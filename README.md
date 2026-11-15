# MEDICAL BOOK AI – Web MVP

Đây là bản MVP kỹ thuật để kiểm tra khả năng chạy mô hình ngôn ngữ cục bộ trong trình duyệt, không phải bản hoàn thiện dùng dịch sách y khoa.

## Tính năng hiện có
- Giao diện tiếng Việt, phù hợp màn hình điện thoại.
- Kiểm tra WebGPU.
- Tải mô hình Qwen2.5 0.5B Instruct qua WebLLM.
- Đọc PDF có lớp văn bản bằng PDF.js.
- Chia nội dung thành các đoạn nhỏ.
- Gửi từng đoạn cho mô hình cục bộ để dịch.
- Lưu tiến độ từng đoạn vào IndexedDB.
- Xuất kết quả dạng TXT.

## Giới hạn chưa hoàn thiện
- PDF scan chưa có OCR.
- Chưa khôi phục phiên dịch đầy đủ sau khi đóng Safari.
- Chưa xuất PDF/DOCX, chưa bảo toàn bố cục/hình/bảng.
- Chưa kiểm định chất lượng dịch y khoa.
- Chưa kiểm thử trên iPhone 12 Pro thực tế.
- Cần Internet để tải thư viện và mô hình lần đầu; sau đó khả năng dùng ngoại tuyến phụ thuộc cache của Safari.
- Safari có thể đóng tab/giải phóng bộ nhớ khi tải mô hình hoặc xử lý lâu.

## Chạy thử
Website cần được phục vụ qua HTTPS (không mở trực tiếp file index.html). Có thể đưa thư mục này lên một static host HTTPS. Sau đó mở URL bằng Safari iOS 26+ và kiểm tra WebGPU.

Mô hình được chọn: Qwen2.5-0.5B-Instruct-q4f16_1-MLC. Đây chỉ là mô hình nhỏ để thử khả năng chạy trên thiết bị; không được xem là đã đạt chất lượng dịch thuật y khoa.
