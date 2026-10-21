# Prototipe login CRM lokal

Prototipe memakai TAGTOG dan EMS-IAM untuk login, lalu menghubungkan identitas IAM ke user CRM yang sudah ada. Role dan akses event CRM tetap diperiksa pada user CRM tersebut. Paket, akun perusahaan, isolasi workspace baru, dan masa aktif bisnis belum diimplementasikan.

## Lingkungan terpisah

| Komponen | Alamat atau lokasi |
| --- | --- |
| TAGTOG | `http://127.0.0.1:4180` |
| EMS-IAM | `http://127.0.0.1:8181` |
| CRM API | `http://127.0.0.1:8186` |
| CRM web | `http://127.0.0.1:8188` |
| PostgreSQL CRM | Loopback `55433`, database `tagtog_crm`, container `tagtog-local-crm-db` |
| Source CRM API | `.local/worktrees/crm_be` |
| Source CRM web | `.local/worktrees/crm_fe` |

Source CRM memakai branch lokal terpisah. Perubahan EMS/EO pada folder CRM asli tidak dipindahkan ke prototipe ini. Kredensial, database, process records, log, dan worktree berada di `.local/` yang diabaikan Git. Tidak ada pengguna, role grant, atau mapping akun yang dibuat otomatis oleh helper CRM.

## Menyiapkan dan menjalankan

Prasyarat: lingkungan IAM lokal dari `local-stack.cjs` sudah tersedia, Docker Desktop berjalan, Java 21 dan Node 20+ tersedia, JAR CRM dengan profil `tagtog-local` sudah dibangun, serta dependensi frontend CRM asli sudah terpasang. Helper membuat junction ke dependensi tersebut; tidak memasang paket baru.

```powershell
node crm-local.cjs prepare
```

Perintah ini membuat database CRM terpisah, secret SSO CRM yang independen, serta entri registry `CRM` dan fitur `workspace` di database IAM fixture `tagtog_iam`. User, grant, dan pemetaan user perlu disiapkan secara eksplisit pada fixture tersebut. Pengujian tidak memakai database produksi.

IAM dan portal yang sudah berjalan perlu dimulai ulang melalui proses lokal yang dimiliki stack agar membaca konfigurasi CRM baru. `crm-local.cjs` tidak menghentikan atau memulai ulang IAM/portal. Setelah keduanya memakai source dan konfigurasi terbaru:

```powershell
node crm-local.cjs start
node crm-local.cjs status
```

Login di TAGTOG, pastikan akun memperoleh akses aplikasi CRM dan izin fitur `workspace`, lalu buka **Users & Access → Application account links → CRM** untuk menautkan identitas IAM ke user CRM yang dimaksud. Email yang mirip tidak membuat mapping otomatis. Akun tanpa grant atau tanpa mapping ditolak.

Untuk menyiapkan akun uji milik lingkungan terisolasi ini secara eksplisit, jalankan:

```powershell
node test/crm-local-fixtures.cjs seed
```

Script memverifikasi container/database lokal, membuat identitas uji viewer/tanpa akses/tanpa mapping, dan memetakan admin IAM lokal ke `tagtog_local_admin` serta viewer ke `tagtog_local_viewer`. Password dibuat acak dan hanya disimpan di `.local/local-config.json`. Ia tidak menggabungkan user yang sudah ada berdasarkan email; akun di luar catatan fixture ditolak. Kredensial admin portal tetap berada di bagian `iamAdmin` pada file privat itu.

`start` menjalankan CRM API dengan profil `tagtog-local`: bind `127.0.0.1:8186`, seed/bootstrap admin mati, dan integrasi EMS eksternal mati. Frontend bind `127.0.0.1:8188` dengan output `.next-tagtog-crm-local`, memakai proxy sesi server dan cookie HttpOnly. Token IAM maupun token CRM tidak dikirim ke localStorage atau URL pada mode SSO.

## Menghentikan CRM

```powershell
node crm-local.cjs stop
```

Helper hanya menghentikan PID yang cocok dengan marker, waktu pembuatan, serta fingerprint command line proses CRM yang dicatatnya. Container harus memiliki label fixture dan binding loopback yang sesuai. Proses aplikasi lain dibiarkan, database volume dipertahankan, dan IAM/PMS/portal tetap berjalan.

Konfigurasi privat disimpan pada `.local/local-config.json` di bawah `crm`. Jangan mengunggah file itu atau berkas `.local/crm-postgres.env`. Process records terpisah ada di `.local/crm-processes.json`; log CRM ada di direktori yang sama.

## Pemeriksaan penerimaan

```powershell
npm test
node test/crm-local-e2e.cjs
```

Suite portal memakai IAM tiruan. Script kedua memakai layanan dan fixture loopback yang sudah berjalan; tidak boleh diarahkan ke server produksi. Uji tersebut mencakup login TAGTOG → CRM, role user lama, token tetap di server, akses API lewat BFF, penolakan token angka/login lama, replay callback, viewer tanpa hak tulis, CSRF, akun tanpa grant/mapping, pencabutan grant, serta logout lokal dan global. Grant fixture yang diubah untuk pengujian dipulihkan dalam `finally`.

Tes frontend terisolasi mencakup state/PKCE, callback kedaluwarsa/salah, replay, CSRF, sanitasi profil, proxy, dan bentuk Request Next dengan alias loopback. Backend menguji binding sesi ke versi mapping, hash token, pemeriksaan IAM, role/CRUD, dan pemisahan client. Hasil login ini tidak membuktikan isolasi data antarperusahaan; aturan tersebut tetap bagian rancangan berikutnya.

## Batas prototipe

Source CRM memakai basis `main` backend `d0b8772` dan frontend `b46b30f`, yang dicocokkan dengan remote pada 21 Oktober 2026. Perubahan EMS/EO yang belum di-commit pada folder CRM asli tetap terpisah. Mode SSO harus tetap diuji dengan data lokal milik sendiri sampai batas data perusahaan dirancang dan diterapkan. Tracking pixel email publik tetap mengikuti perilaku CRM yang sudah ada dan belum diubah menjadi tautan bertanda tangan.

Sesi BFF masih berada di memori satu proses dan memakai cookie HTTP hanya pada loopback. Restart frontend memerlukan login ulang. Deployment membutuhkan konfigurasi HTTPS/domain, penyimpanan sesi bersama, pengujian batas data, dan peninjauan endpoint publik. Tidak ada paket atau masa aktif bisnis yang dimigrasikan oleh prototipe ini.
## Salinan data CRM lama

Preview dapat memakai salinan database CRM lama dari Docker lokal. Database sumber tetap berhenti dan volumenya disalin dengan mount read-only; snapshot PostgreSQL dijalankan tanpa jaringan untuk membuat dump konsisten. Dump, checksum, perbandingan data, dan konfigurasi rollback disimpan hanya di direktori `.local/legacy-import/<importId>/` yang diabaikan Git.

Restore dilakukan ke database staging baru, lalu jumlah baris dan sequence dicocokkan sebelum aktivasi. Database uji kosong sebelumnya tetap disimpan dengan nama arsip lokal. Sesi login lama pada salinan dihapus; tabel, ID, password CRM, role, dan akses event bisnis dipertahankan. Migration SSO hanya dijalankan pada database target lokal.

Setelah salinan legacy aktif, helper fixture kosong dan E2E fixture lama sengaja menolak berjalan agar ID user uji tidak tertukar dengan ID akun asli. Gunakan:

```powershell
node test/crm-legacy-map.cjs audit
node test/crm-legacy-map.cjs map
node test/crm-legacy-e2e.cjs
```

Mapping membuat identitas IAM uji baru untuk setiap akun CRM yang memenuhi syarat. Email asli dipakai jika valid, unik setelah normalisasi, dan belum dipakai IAM; konflik mendapat alias lokal yang dicatat. Tidak ada akun IAM yang digabung hanya berdasarkan email. ID/username/role/event scope CRM diperiksa dengan fingerprint sebelum dan sesudah mapping. Role kosong atau tidak dikenal memerlukan peninjauan, bukan promosi otomatis.

Password TAGTOG untuk hasil salinan dibuat acak dan berbeda dari password CRM lama. Daftar login lokal ada di `.local/legacy-import/<importId>/credentials.json`; `mapping.json` menyimpan mapping dan fingerprint. File ini bersifat privat dan tidak boleh diunggah. Akun admin portal lokal tetap dapat mengelola mapping; akses aplikasi CRM memerlukan tautan eksplisit ke akun CRM hasil restore.

Kopi lokal ini tidak otomatis mencerminkan perubahan terbaru pada server. Uji penerimaan memeriksa profil dan cakupan event akun lama serta jumlah kontak, perusahaan, dan event melalui aplikasi tanpa memodifikasi data bisnis.

## Legacy password sandbox

Preserved-password testing uses a separate IAM/CRM database pair and http://localhost:4192. Existing IAM users remain untouched. See [the migration guide](PASSWORD-MIGRATION-LOCAL.md) for setup, conflict behavior, acceptance tests and private-file handling.
