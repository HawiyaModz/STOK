STOKKU - PENYIMPANAN KE FILE GITHUB (VERCEL)

File data yang otomatis dibuat/diperbarui di root repository:
- produk.js  : daftar produk dan stok
- user.js    : akun pengguna
- chat.js    : pesan chat (agar fitur chat lama tetap tersimpan)

PENTING:
1. Gunakan repository GitHub PRIVATE karena user.js berisi data akun.
2. Jangan pernah menaruh GITHUB_TOKEN di index.html atau kode browser. Token hanya di Environment Variables Vercel.
3. Buat GitHub Personal Access Token (fine-grained) yang hanya diberi akses Contents: Read and write ke repository StokKu.
4. Pastikan token punya akses ke branch yang dipakai (default: main).

Tambahkan Environment Variables berikut di Vercel > Project > Settings > Environment Variables:

GITHUB_TOKEN   = token GitHub dengan izin Contents Read and write
GITHUB_OWNER   = username atau organisasi pemilik repository
GITHUB_REPO    = nama repository, tanpa URL
GITHUB_BRANCH  = main (sesuaikan jika branch utama berbeda)

Opsional untuk menentukan lokasi file:
GITHUB_PRODUCTS_PATH = produk.js
GITHUB_USERS_PATH    = user.js
GITHUB_CHATS_PATH    = chat.js

Setelah menyimpan Environment Variables, lakukan Redeploy.
Saat API pertama kali dipanggil, backend akan membuat file produk.js, user.js, dan chat.js jika belum ada.
Setiap perubahan produk hanya memperbarui produk.js. Setiap perubahan akun hanya memperbarui user.js.
Perubahan chat memperbarui chat.js.

FORMAT FILE:
Masing-masing file adalah JavaScript module berisi `export default [...]`.

CATATAN OPERASIONAL:
- Setiap perubahan data membuat commit baru ke GitHub. Ini memang sesuai permintaan agar file repository ikut berubah.
- GitHub API memiliki rate limit dan batas ukuran file; untuk penggunaan besar, database seperti Redis/Postgres lebih cocok.
- Jika dua orang mengubah file yang sama tepat bersamaan, salah satu permintaan bisa mendapat konflik. Muat ulang aplikasi lalu coba lagi.
- File user.js berisi password dalam format yang sudah dipakai aplikasi awal. Repository PRIVATE wajib. Sebaiknya aplikasi dikembangkan lagi untuk menyimpan password dalam bentuk hash sebelum dipakai publik.
- Akun admin bawaan tetap: username `admin`, password `admin123`. Segera ganti setelah login pertama.
