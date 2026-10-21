/* Konfigurasi alamat aplikasi TAGTOG.
 * Isi URL HTTPS lengkap atau path relatif ketika aplikasi sudah tersedia.
 * Nilai kosong membuka dialog pratinjau, tanpa mengirim data.
 * Contoh: ems: "https://ems.example.com" atau ems: "/ems/"
 * Login dan hak akses harus ditangani oleh IAM/backend aplikasi tujuan.
 */
window.PORTAL_CONFIG = {
  appUrls: {
    ems: "",
    pms: "",
    crm: ""
  }
};
