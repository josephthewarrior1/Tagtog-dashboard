# TAGTOG — Portal aplikasi lokal

Portal pemilih aplikasi EMS, PMS, dan CRM untuk KIM Communication. Desain kedua memakai sidebar gelap, judul sambutan yang lapang, dan tiga kartu aplikasi dengan panel berwarna. Fitur operasional tetap berada di aplikasi masing-masing.

## Menjalankan

1. Klik dua kali `start-local.cmd`.
2. Buka **http://127.0.0.1:4180/** di browser.
3. Biarkan jendela server terbuka selama portal digunakan. Tekan **Ctrl+C** untuk menghentikannya.

Python 3 harus tersedia melalui perintah `python` atau `py`. Alternatif: buka `index.html` langsung di browser untuk melihat portal dan dialog pratinjau tanpa server.

Semua aset tersimpan dalam folder ini. Tidak ada font, gambar, atau pustaka yang dimuat dari layanan luar.

## Menghubungkan aplikasi

Ubah alamat pada `config.js`:

```javascript
window.PORTAL_CONFIG = {
  appUrls: {
    ems: "https://alamat-ems.example.com",
    pms: "https://alamat-pms.example.com",
    crm: "https://alamat-crm.example.com"
  }
};
```

Nilai kosong membuka dialog pratinjau. Alamat HTTP/HTTPS diperbolehkan; protokol lain dan alamat yang berisi kredensial ditolak. Path relatif, misalnya `/ems/`, dapat digunakan ketika portal dijalankan melalui server. Aplikasi yang telah dikonfigurasi terbuka di tab baru.

Portal ini belum memiliki login IAM atau backend. Profil Jo adalah contoh. Otentikasi, sesi login, dan hak akses perlu ditangani oleh IAM/backend dan aplikasi tujuan ketika integrasi dilakukan.

## Interaksi

- Cari aplikasi berdasarkan singkatan, nama, deskripsi, atau kata fitur.
- Tekan **Ctrl+K**, **⌘+K**, atau **/** untuk mencari.
- Gunakan **↑/↓** dan **Enter** untuk memilih hasil pencarian.
- Tekan **Esc** untuk menutup dialog, hasil pencarian, atau navigasi mobile.
- Menu mobile mendukung navigasi keyboard dan mengembalikan fokus setelah ditutup.

## Struktur

- `index.html` — struktur halaman dan ikon SVG.
- `styles.css` — tema, tata letak desktop/mobile, dan fokus keyboard.
- `app.js` — pencarian, pratinjau aplikasi, navigasi, dan jam Jakarta.
- `config.js` — alamat tujuan EMS/PMS/CRM.
- `assets/` — logo TAGTOG serta aset tersimpan dari versi sebelumnya. Ilustrasi portal saat ini memakai SVG lokal pada halaman.

Tidak ada proses build, dependensi npm, pelacakan analitik, atau penyimpanan data pengguna.

## Sumber desain

Folder `design/` berisi sumber desain pendamping:

- `tagtog-portal.figcraft` — desain desktop dan mobile yang dapat diedit dengan FigCraft 0.8.0.
- `desktop-design.png` — ekspor tampilan desktop.
- `mobile-design.png` — ekspor tampilan mobile.

Desain kedua memakai sidebar gelap, sambutan tipografis, ilustrasi tiga ruang kerja, serta kartu EMS/PMS/CRM dengan panel warna masing-masing. Banner foto arsitektur telah diganti. Dokumen FigCraft berisi layer yang dapat diedit untuk desktop dan mobile.
