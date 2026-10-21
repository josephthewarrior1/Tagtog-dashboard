# Draft Rencana Integrasi Akun TAGTOG EMS PMS dan CRM

Tanggal 21 Oktober 2026. Tahap minggu ini: audit schema dan penyepakatan rancangan. Kebutuhan yang sudah dikonfirmasi: mendukung akun personal dan perusahaan, paket akses, serta masa aktif paket dan akses anggota.

Identitas login perlu satu sumber di EMS-IAM. ID user dan relasi bisnis yang sudah ada di setiap aplikasi tetap dipertahankan melalui mapping yang eksplisit. Menyamakan seluruh tabel user akan berisiko mengubah kepemilikan proyek, event, dan data pelanggan.

## Hasil audit source saat ini

Audit ini mencakup model, migration, dan pemeriksaan akses pada source. Schema fisik serta versi deployment database produksi masih perlu dicocokkan sebelum rancangan menjadi migration.

| Bagian | Identitas dan role | Masa aktif dan paket | Implikasi |
| --- | --- | --- | --- |
| EMS-IAM | `iam.users.id` BIGINT; email unik, full_name, password_hash, status ACTIVE/INACTIVE. Role melalui `user_roles`, akses aplikasi melalui `role_system_access`, fitur melalui `role_feature_permissions`. | Belum ada masa aktif akun bisnis atau paket. `refresh_tokens.expires_at` adalah masa sesi login. | Cocok menjadi sumber identitas; hak berlangganan perlu model terpisah. |
| EMS-API | Akun pelanggan di `ems.client_accounts`; anggota menunjuk `iam.users.id` melalui `client_account_members.user_id`. | Sudah ada `contract_start_at`, `contract_end_at`, status ACTIVE/SUSPENDED/EXPIRED, batas member/event, `client_plan_features`, dan `event_features`. | Ada fondasi pelanggan dan fitur berbayar yang perlu dipetakan, bukan dibuat ulang tanpa rekonsiliasi. |
| PMS | `users.id` BIGINT; username, email, name, password_hash, active, approved, employment_type, client_id. Global role: ADMIN, MANAGER, USER, MEETING_READER, SCHEDULE_VIEWER. Ada membership dan role per proyek. | Belum ada paket atau masa aktif akun. `sessions.expires_at` membatasi sesi. | Mapping identitas harus menjaga user ID, membership proyek, client folder shares, dan batas role khusus. |
| CRM | `app_users.id` BIGINT; username, email, full_name, password, created_at. Role: ADMIN, MANAGER, USER; cakupan event melalui `user_allowed_events`. | Belum ada status akun aktif/nonaktif, membership pelanggan, paket, atau masa aktif akun. Sesi memiliki expiry tersendiri. | Membutuhkan penyesuaian siklus akun dan pembatasan data sebelum integrasi personal/perusahaan. |

Walaupun sama-sama memakai BIGINT, nilai ID di tiga aplikasi tidak menunjukkan orang yang sama. Email dipakai untuk pencarian kandidat mapping, lalu dikonfirmasi; email bukan kunci untuk penggabungan otomatis.

## Perbedaan yang harus diselesaikan

**EMS sudah memiliki aturan bisnis kontrak.** Akun pelanggan yang suspended atau expired menjadi read-only di area admin, sementara fungsi peserta tetap mengikuti aturan EMS. `client_plan_features` merupakan template yang disalin ke `event_features` saat event ditetapkan; perubahan template tidak otomatis mengubah semua event lama.

`contract_start_at` sudah tersimpan, tetapi pemeriksaan status efektif saat ini memakai status dan tanggal akhir kontrak. Penerapan tanggal mulai perlu dimasukkan ke kontrak akses yang disepakati.

**Membership EMS saat ini membatasi satu user pada satu akun pelanggan.** Ada UNIQUE pada `client_account_members.user_id`, dan scope diambil berdasarkan user. Jika satu orang nanti memiliki akun personal sekaligus menjadi anggota perusahaan, pemilihan workspace dan mapping account perlu dirancang sebelum constraint tersebut diubah.

Pada source saat ini, membership/account yang tidak ditemukan dapat menghasilkan scope `Internal`. Untuk rancangan beberapa workspace, identitas staff internal harus dibedakan secara eksplisit; identitas pelanggan dengan membership hilang harus ditolak. Perubahan ini menjadi syarat sebelum constraint membership diperluas.

**PMS memiliki beberapa jalur kepemilikan data.** Akses proyek berasal dari `project_users`, `project_members`, beberapa pencocokan email team member, serta folder share untuk client. Sebagian pemeriksaan create/update menggunakan membership internal, bukan seluruh flag CRUD pada role proyek. Nama role saja belum cukup untuk membuat matriks hak akses yang akurat. `clients.id` adalah data pelanggan, belum menjadi batas tenant yang menyeluruh.

**CRM memerlukan batas data per workspace.** Company/group adalah data pelanggan atau holding, bukan pemilik akun login. Daftar database pelanggan tertentu saat ini dibaca secara global setelah autentikasi. Menambah tabel paket tidak otomatis memisahkan data personal dan perusahaan.

**Sesi CRM perlu diperbaiki sebelum disambungkan.** Source saat ini menggunakan ID angka baris sesi sebagai Bearer token. Rancangan integrasi harus menggantinya dengan token acak yang tidak dapat ditebak atau mekanisme sesi pusat yang tervalidasi, termasuk pencabutan sesi. Temuan ini berasal dari source; tidak dilakukan percobaan terhadap server.

**Ada backend TAGTOG lain untuk administrasi demo.** `tagtog-be` memiliki tabel `admins` dengan UUID dan `demo_requests`. Identitas admin demo ini perlu diinventarisasi, tetapi tidak langsung dipilih menjadi sumber login untuk seluruh workspace. EMS-IAM tetap menjadi kandidat sumber identitas sesuai arah awal.

## Konsep akun personal dan perusahaan

Satu orang mempunyai satu identitas IAM. Identitas tersebut dapat menjadi anggota satu atau beberapa akun/workspace. Akun berjenis PERSONAL mewakili pemakaian individu; akun ORGANIZATION mewakili perusahaan dengan beberapa anggota.

Paket ditempelkan pada akun/workspace. Dengan begitu akun personal dan perusahaan memakai mekanisme yang sama. Anggota perusahaan dapat diberi masa aktif dan role sendiri, sehingga akses seorang anggota dapat berakhir tanpa mengakhiri paket perusahaan.

Contoh: seorang user memiliki paket personal PMS hingga 31 Desember dan menjadi anggota perusahaan yang memiliki paket EMS/PMS hingga 30 November. Akses dalam workspace perusahaan mengikuti paket dan membership perusahaan; hak dari workspace personal tidak boleh digabung untuk membuka data perusahaan.

## Usulan struktur data pusat

Nama dan penempatan schema berikut masih rancangan. Pemilik tabel antara IAM dan layanan account perlu ditetapkan bersama pemilik EMS agar aturan yang sudah ada tidak menjadi dua sumber kebenaran.

| Struktur | Isi utama | Fungsi |
| --- | --- | --- |
| `accounts` | id, type PERSONAL/ORGANIZATION, name, status | Pemilik workspace dan paket. |
| `account_memberships` | account_id, iam_user_id, status, valid_from, valid_until | Keanggotaan serta batas waktu akses per orang. Unik untuk pasangan account dan user. |
| `membership_roles` | membership_id, role_id | Role dalam account terpilih; role administrator perusahaan tidak otomatis berlaku di account lain. |
| `packages` | id, code, version, name, status | Katalog paket dengan versi yang tetap untuk pelanggan yang sudah ditetapkan. Belum menetapkan nama komersial, harga, atau kuota. |
| `package_entitlements` | package_id, system_code, feature_code, allowed_actions, limits | Isi paket: aplikasi, fitur, operasi, dan batas pemakaian yang disepakati. |
| `account_subscriptions` | account_id, package_id, starts_at, ends_at, status | Penetapan paket dan periode aktifnya, dapat dikelola manual terlebih dahulu. |
| `application_identity_links` | issuer, subject, system_code, local_user_id | Menghubungkan identitas IAM ke user lama setiap aplikasi tanpa mengubah primary key user lama. |
| `account_application_links` | account_id, system_code, local_account_id | Menghubungkan account pusat dengan workspace pelanggan aplikasi bila aplikasi mempunyai konsep tersebut. Tidak menganggap PMS client atau CRM company otomatis sebagai tenant. |

`issuer` dan `subject` menjadi kunci identitas lintas aplikasi. Email dan nama adalah atribut yang dapat berubah. Kontrak profil harus menyepakati penamaan, normalisasi email, status, dan perilaku perubahan email; tidak membagikan password antar aplikasi.

Mapping identitas memerlukan UNIQUE `(issuer, subject, system_code)` serta UNIQUE `(system_code, local_user_id)`. Jika mapping account dibuat satu banding satu, UNIQUE juga dibutuhkan untuk `(account_id, system_code)` dan pasangan sistem dengan account lokalnya. Role pada membership merupakan role di account tersebut; pemberian role pelanggan tidak boleh memberikan role global SUPER_ADMIN.

Tanggal bisnis disimpan sebagai waktu UTC dengan batas akhir yang konsisten; tampilan dapat memakai WIB. Sesi login tetap mempunyai batas waktu keamanan yang terpisah. Jika suatu identitas benar-benar harus berakhir secara global, atur kebijakan identitas tersendiri; berakhirnya satu membership atau paket tidak otomatis menonaktifkan orang tersebut di seluruh account.

## Cara menentukan akses efektif

Pemeriksaan dilakukan di backend aplikasi pada setiap permintaan yang relevan. Portal menampilkan hasil akses yang sama agar pengguna memahami pilihan workspace dan aplikasi yang tersedia.

Account yang dipilih harus divalidasi dan diikat pada konteks sesi oleh server. Backend memeriksa kepemilikan resource terhadap account tersebut; nilai `account_id` dari UI bukan bukti akses. Hak dari workspace personal dan perusahaan tidak dijumlahkan.

1. Identitas IAM harus aktif dan terautentikasi.
2. Workspace yang dipilih harus sesuai dengan membership user yang aktif dan masih berlaku.
3. Paket workspace menentukan aplikasi, fitur, tindakan, serta periode yang tersedia.
4. Role anggota membatasi tindakan di dalam hak paket tersebut.
5. Aturan bisnis aplikasi membatasi proyek, event, folder, atau data yang boleh diakses.

Hak paket adalah batas atas. Role user tidak menambah fitur yang tidak tercakup paket, dan akses aplikasi tidak berarti akses ke seluruh data aplikasi. Role internal seperti SUPER_ADMIN memerlukan kebijakan terpisah yang eksplisit.

Saat paket expired, perilaku perlu diputuskan per aplikasi: aplikasi diblokir atau tersedia read-only. EMS sudah memiliki pola read-only untuk kontrak; pola tersebut harus ditinjau sebelum aturan pusat diberlakukan. Portal dapat tetap menyediakan akses ke status akun/paket meskipun akses bisnis aplikasi telah berakhir.

## Tahap pertama minggu ini

1. Cocokkan migration dan entity dengan metadata database yang benar-benar dipakai pada masing-masing lingkungan. Catat perbedaan tanpa mengubah data produksi.
2. Selesaikan data dictionary untuk user, role, membership, client/company, session, dan seluruh foreign key kepemilikan data.
3. Buat matriks akses per aplikasi: siapa dapat membuka aplikasi, tindakan apa yang diizinkan, dan data mana yang menjadi cakupannya.
4. Inventarisasi kandidat user yang sama, email ganda/berbeda, akun nonaktif, serta keterkaitan ke perusahaan. Mapping akun bermasalah harus ditinjau, bukan digabung otomatis.
5. Sepakati pemilik account dan paket pusat, dukungan beberapa workspace per user, perilaku saat expired, perubahan paket untuk data lama, serta aturan role internal.
6. Review ERD usulan, kontrak identitas, mapping schema lama, dan rencana migration/rollback bersama pemilik EMS, PMS, dan CRM. Implementasi dilanjutkan setelah rancangan ini disepakati.

Hasil yang harus tersedia pada akhir tahap ini: kamus schema ketiga aplikasi, matriks akses, daftar konflik identitas, rancangan account/paket/masa aktif, dan urutan migration yang mempertahankan user ID serta kepemilikan data.

## Urutan implementasi setelah rancangan disepakati

Pertama siapkan identity mapping dan model account/membership tanpa menghapus user lama. Berikutnya siapkan paket dan evaluasi hak akses. Sambungkan PMS sebagai pilot lokal, kemudian EMS dan CRM setelah penyesuaian scope serta sesi masing-masing. Pengujian mencakup dua workspace berbeda, pergantian account, akses anggota yang berakhir, paket expired, pencabutan role, serta pemeliharaan kepemilikan data.

Source portal untuk prototipe SSO berada di repositori ini; penyesuaian EMS-IAM dan PMS tersimpan terpisah di branch lokal repositori masing-masing. Prototipe tersebut belum menjadi implementasi final paket atau masa aktif, dan pengujian end-to-end belum dijalankan. Sebelum validasi runtime dilanjutkan nanti, executable PMS perlu dibangun ulang setelah proses yang mengunci jar dihentikan. Pekerjaan berikutnya dibatasi pada audit dan perencanaan sesuai arahan terbaru; tidak ada rollout produksi.

## Referensi source

| Bagian | Source utama |
| --- | --- |
| IAM dasar | V2 schema IAM (`ems-v2/EMS-IAM/src/main/resources/db/migration/V2__iam_core.sql:11`) dan UserEntity (`ems-v2/EMS-IAM/src/main/kotlin/com/ems/iam/domain/UserEntity.kt:20`) |
| EMS account dan entitlement | V25 account pelanggan (`ems-v2/EMS-API/src/main/resources/db/migration/V25__client_accounts_and_event_grants.sql:18`) dan ClientScopeService (`ems-v2/EMS-API/src/main/kotlin/com/ems/api/client/service/ClientScopeService.kt:69`) |
| PMS user dan relasi proyek | AppUser (`pms_be/src/main/java/com/pms/domain/AppUser.java:28`) dan ProjectPermissionService (`pms_be/src/main/java/com/pms/service/ProjectPermissionService.java:72`); model SessionToken, ProjectMember, ProjectRole pada folder domain yang sama |
| CRM user dan sesi | AppUser (`Crm_Kimcommunication_be/src/main/java/com/crm/domain/AppUser.java:18`) dan SecurityHelper (`Crm_Kimcommunication_be/src/main/java/com/crm/service/SecurityHelper.java:28`); SessionToken dan AuthController pada project yang sama |
| CRM batas data | DatabaseController (`Crm_Kimcommunication_be/src/main/java/com/crm/controller/DatabaseController.java:65`); model Company dan Database pada project yang sama |
| Admin demo TAGTOG | Schema admin demo (`tagtog-be/src/database.js:54`) |

Basis PMS terbaru yang sudah di-fetch: frontend `34c57e8`, backend `a13d465` (20 Oktober 2026). EMS-IAM `8879a8a` dan EMS-API `c060198` sama dengan main remote yang sudah diverifikasi. CRM juga sudah di-fetch: backend `d0b8772`, frontend `b46b30f`; core user dan autentikasi sama dengan main remote tersebut. Versi source tidak menggantikan verifikasi versi aplikasi dan schema yang terpasang di server.
