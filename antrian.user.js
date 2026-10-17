// ==UserScript==
// @name         Kirim Antrian Poli ke Display (Panggil + Tunda + Lab)
// @namespace    puskesmas-gilingan
// @version      5.1
// @description  Membaca antrian poli dan laboratorium j-care, mengirim ke display, dan menambah tombol Panggil dan Tunda
// @match        http://10.12.10.124:800/j-care/*
// @match        http://192.168.1.200/j-care/*
// @noframes
// @updateURL    https://ajinugroho25-droid.github.io/display/antrian.user.js
// @downloadURL  https://ajinugroho25-droid.github.io/display/antrian.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  // ===== PENGATURAN =====
  // Diisi sekali per komputer lewat menu Tampermonkey > "Pengaturan Display Antrian".
  // Disimpan di Tampermonkey, jadi tidak hilang saat skrip diperbarui.
  const DEFAULT = {
    URL: '',            // alamat Apps Script berakhiran /exec
    TOKEN: '',          // sama dengan TOKEN di Code.gs
    UNIT: [],           // unit poli yang dikirim dari komputer ini; kosong = semua unit yang tampil di login ini
    LAB: false,         // true hanya di komputer yang boleh membuka halaman laboratorium (login lab atau admin)
    HALAMAN: '/j-care/visits/index_unit',        // halaman antrian poli yang dibaca di latar belakang
    HALAMAN_LAB: '/j-care/visits/index_laborat', // halaman laboratorium
    INTERVAL: 5000,     // ms jeda membaca halaman SIMPUS; data dikirim hanya bila berubah
    UJI: false          // uji coba saat semua pasien "Sudah": true = semua dianggap "Belum". Kembalikan ke false.
  };
  let tersimpan = {};
  try { tersimpan = JSON.parse(GM_getValue('cfg', '{}')); } catch (e) { tersimpan = {}; }
  const CFG = Object.assign({}, DEFAULT, tersimpan);

  GM_registerMenuCommand('Pengaturan Display Antrian', () => {
    const url = prompt('Alamat Apps Script (berakhiran /exec):', CFG.URL || '');
    if (url === null) return;
    const token = prompt('Token (sama dengan di Code.gs):', CFG.TOKEN || '');
    if (token === null) return;
    const unit = prompt('Unit poli yang dikirim dari komputer ini, pisahkan dengan koma.\nKosongkan untuk semua unit yang tampil:', (CFG.UNIT || []).join(', '));
    if (unit === null) return;
    const lab = prompt('Baca halaman laboratorium di komputer ini? Ketik ya atau tidak:', CFG.LAB ? 'ya' : 'tidak');
    if (lab === null) return;
    GM_setValue('cfg', JSON.stringify({
      URL: url.trim(), TOKEN: token.trim(),
      UNIT: unit.split(',').map(x => x.trim()).filter(Boolean),
      LAB: /^y/i.test(lab.trim())
    }));
    location.reload();
  });

  const LAB_POLI = 'Laborat';
  const HEARTBEAT = 30000; // ms; kirim ulang minimal tiap 30 detik agar poli tidak dianggap terputus

  let tundaIds = new Set();   // ditunda manual
  let lepasIds = new Set();   // dilepas dari penahanan otomatis lab
  let panggilIds = new Set();
  let labBelum = new Set();   // No RM pasien yang pemeriksaan labnya masih BELUM

  // Id acak yang tetap per browser; membedakan komputer pengirim di Apps Script
  const PENGIRIM = (() => {
    const baru = () => Math.random().toString(36).slice(2, 8);
    try {
      let v = localStorage.getItem('da-pengirim');
      if (!v) { v = baru(); localStorage.setItem('da-pengirim', v); }
      return v;
    } catch (e) { return baru(); }
  })();

  // ---------- notifikasi di halaman SIMPUS ----------
  function toast(teks, galat) {
    let t = document.getElementById('da-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'da-toast';
      t.style.cssText = 'position:fixed;top:12px;right:12px;z-index:99999;padding:10px 16px;border-radius:6px;' +
        'font:600 13px/1.35 verdana,sans-serif;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.35);' +
        'transition:opacity .3s;max-width:380px';
      document.body.appendChild(t);
    }
    t.textContent = teks;
    t.style.background = galat ? '#C0392B' : '#1E7B4F';
    t.style.opacity = '1';
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.opacity = '0'; }, 3500);
  }

  // ---------- komunikasi dengan Apps Script ----------
  function post(payload, cb, fail) {
    GM_xmlhttpRequest({
      method: 'POST',
      url: CFG.URL,
      headers: { 'Content-Type': 'text/plain' },
      data: JSON.stringify(Object.assign({ token: CFG.TOKEN }, payload)),
      timeout: 15000,
      onload: r => {
        try {
          const j = JSON.parse(r.responseText);
          if (j.error) { console.warn('[Display Antrian] ditolak server:', j.error); fail && fail(); return; }
          cb && cb(j);
        } catch (e) { console.warn('[Display Antrian] respons tak terbaca', e); fail && fail(); }
      },
      onerror: e => { console.warn('[Display Antrian] gagal kirim', e); fail && fail(); },
      ontimeout: () => { console.warn('[Display Antrian] waktu habis'); fail && fail(); }
    });
  }

  function perbarui(res) {
    tundaIds = new Set(res.tunda || []);
    lepasIds = new Set(res.lepas || []);
    labBelum = new Set(res.labBelum || []);
    panggilIds = new Set(Object.keys(res.panggil || {}).map(p => res.panggil[p].id));
    pasangTombol();
  }

  // ---------- tanggal ----------
  // Format dd-mm-yyyy, sama dengan kolom Tanggal di SIMPUS
  function hariIni() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return p(d.getDate()) + '-' + p(d.getMonth() + 1) + '-' + d.getFullYear();
  }
  // Tanggal yang dipakai halaman: kolom input bernilai dd-mm-yyyy (null bila tidak ditemukan)
  function tanggalHalaman(doc) {
    const i = [...doc.querySelectorAll('input')].find(x => /^\d{2}-\d{2}-\d{4}$/.test((x.value || '').trim()));
    return i ? i.value.trim() : null;
  }

  // ---------- membaca tabel (halaman poli dan halaman laboratorium) ----------
  function header(doc) {
    const ths = [...doc.querySelectorAll('th')];
    const th = ths.find(t => t.textContent.trim() === 'No Antrian') || ths.find(t => t.textContent.trim() === 'Sample ID');
    if (!th) return null;
    const hs = [...th.parentElement.children].map(c => c.textContent.trim());
    const i = n => hs.indexOf(n);
    const lab = i('No Antrian') < 0;
    return {
      th: th,
      lab: lab,
      k: lab
        ? { u: i('No'), w: i('Waktu Daftar Lab'), rm: i('No RM'), a: i('Sample ID'), n: i('Nama'), s: i('Periksa'), act: i('Action') }
        : { u: i('No'), w: i('Waktu Dilayani'), rm: i('No.Index'), a: i('No Antrian'), n: i('Nama'), s: i('Status'), p: i('Unit Pelayanan'), act: 0 }
    };
  }

  // id kunjungan diambil dari link di baris. Id lab diberi awalan L agar tidak bentrok dengan id poli.
  function idBaris(tr, lab) {
    const sel = lab ? 'a[href*="/visits/add_laborat/"]'
                    : 'a[href*="/visits/delete_kunjungan/"], a[href*="/visits/print_rm/"], a[href*="/visits/add_unit/"]';
    const a = tr.querySelector(sel);
    const m = a && a.getAttribute('href').match(/\/visits\/(?:delete_kunjungan|print_rm|add_unit|add_laborat)\/(\d+)/);
    return m ? (lab ? 'L' : '') + m[1] : '';
  }

  function baris(tr, H) {
    const k = H.k, td = tr.querySelectorAll(':scope > td');
    if (td.length <= k.n) return null;
    const a = td[k.n].querySelector('a');
    const nama = (a || td[k.n]).textContent.trim();
    if (!nama) return null;
    let unit, status;
    if (H.lab) {
      unit = LAB_POLI;
      status = td[k.s].textContent.trim().toUpperCase() === 'SUDAH' ? 'Sudah' : 'Belum';
    } else {
      const opt = td[k.p] && td[k.p].querySelector('select option[selected]');
      unit = opt ? opt.textContent.trim() : '';
      status = td[k.s].textContent.trim(); // "Sudah" = sudah dilayani, "Belum" = belum
    }
    if (!unit) return null; // baris tanpa unit (mis. rujukan) dilewati
    return {
      aksi: td[k.act],                                   // sel tempat tombol dipasang
      id: idBaris(tr, H.lab),
      urut: parseInt(td[k.u].textContent, 10) || 0,      // kolom "No" (urutan di tabel)
      no: td[k.a].textContent.trim(),                    // No Antrian (poli, bisa "-") atau Sample ID (lab)
      nama: nama,
      jam: td[k.w].textContent.trim().slice(11, 16),
      status: status,
      unit: unit,
      rm: k.rm >= 0 && td[k.rm] ? td[k.rm].textContent.trim() : '' // No.Index (poli) = No RM (lab)
    };
  }

  function parse(doc) {
    const H = header(doc);
    if (!H) return null; // bukan halaman antrian / sesi habis
    const items = [];
    H.th.closest('table').querySelectorAll('tr').forEach(tr => {
      const r = baris(tr, H);
      if (!r) return;
      if (!H.lab && r.unit === LAB_POLI) return; // antrian lab dibaca dari halaman laboratorium
      items.push({ id: r.id, urut: r.urut, no: r.no, nama: r.nama, jam: r.jam,
                   status: CFG.UJI ? 'Belum' : r.status, unit: r.unit, rm: r.rm });
    });
    return { lab: H.lab, items: items };
  }

  function kelompokPoli(items) {
    const g = {};
    CFG.UNIT.forEach(u => { if (u !== LAB_POLI) g[u] = []; });
    items.forEach(i => {
      if (CFG.UNIT.length && !(i.unit in g)) return;
      (g[i.unit] = g[i.unit] || []).push(i);
    });
    return Object.keys(g).map(poli => ({ poli: poli, items: g[poli] }));
  }

  // ---------- tombol Panggil dan Tunda ----------
  function otomatisLab(r) { // ditahan otomatis karena pemeriksaan lab belum selesai
    return r.unit !== LAB_POLI && !!r.rm && labBelum.has(r.rm) && !tundaIds.has(r.id) && !lepasIds.has(r.id);
  }
  function tahan(r) { return tundaIds.has(r.id) || otomatisLab(r); }

  function gagal(b, pesan) {
    b.disabled = false;
    b.textContent = 'Gagal, ulangi';
    b.style.background = '#E57373';
    toast(pesan, true);
    setTimeout(pasangTombol, 3000); // kembalikan label sesuai status terakhir
  }

  function tombol(teks) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = teks;
    b.style.cssText = 'font-size:10px;padding:1px 5px;cursor:pointer';
    return b;
  }

  function pasangTombol() {
    const H = header(document);
    if (!H) return;
    const tgl = tanggalHalaman(document);
    if (tgl && tgl !== hariIni()) return; // halaman tanggal lain: jangan pasang tombol
    H.th.closest('table').querySelectorAll('tr').forEach(tr => {
      const r = baris(tr, H);
      if (!r || !r.id || !r.aksi || (r.status !== 'Belum' && !CFG.UJI)) return;
      let box = r.aksi.querySelector('.da-box');
      if (!box) {
        box = document.createElement('div');
        box.className = 'da-box';
        box.style.cssText = 'display:flex;gap:4px;justify-content:center;margin-top:4px';
        const bp = tombol('Panggil'), bt = tombol('Tunda');
        bp.className = 'da-panggil';
        bt.className = 'da-tunda';
        bp.onclick = () => {
          bp.disabled = true;
          bp.textContent = 'Mengirim…';
          post({ aksi: 'panggil', poli: r.unit, id: r.id },
            res => { perbarui(res); toast('Memanggil ' + r.nama + ' (' + r.unit + ')'); },
            () => gagal(bp, 'Gagal memanggil ' + r.nama + '. Periksa koneksi lalu coba lagi.'));
        };
        bt.onclick = () => {
          const on = !tahan(r); // sedang ditahan (manual atau otomatis lab) berarti klik ini = Kembali
          bt.disabled = true;
          bt.textContent = 'Mengirim…';
          post({ aksi: 'tunda', id: r.id, ditunda: on },
            res => {
              perbarui(res);
              toast(on ? r.nama + ' ditunda. Nama tampil di "Dilewati" pada layar.'
                       : r.nama + ' dikembalikan ke antrian aktif.');
            },
            () => gagal(bt, 'Gagal menunda ' + r.nama + '. Periksa koneksi lalu coba lagi.'));
        };
        box.append(bp, bt);
        r.aksi.appendChild(box);
      }
      const bp = box.querySelector('.da-panggil'), bt = box.querySelector('.da-tunda');
      const dipanggil = panggilIds.has(r.id), manual = tundaIds.has(r.id), oto = otomatisLab(r);
      bp.disabled = false;
      bt.disabled = false;
      bp.textContent = dipanggil ? 'Panggil ulang' : 'Panggil';
      bp.style.background = dipanggil ? '#7FD1A0' : '';
      bt.textContent = manual || oto ? 'Kembali' : 'Tunda';
      bt.title = oto ? 'Ditahan otomatis: pemeriksaan lab belum selesai' : '';
      bt.style.background = manual ? '#F2A900' : (oto ? '#9CC3E8' : '');
      tr.style.background = dipanggil ? '#DFF3E6' : (manual ? '#FFF3CD' : (oto ? '#E3EEF9' : ''));
    });
    console.log('[Display Antrian] tombol terpasang:', document.querySelectorAll('.da-box').length);
  }

  // ---------- siklus pengiriman data ----------
  let terakhir = '', tTerakhir = 0;

  async function ambil(path) {
    // Selalu ambil halaman bawaan (daftar hari ini), apa pun halaman yang sedang dibuka petugas
    const res = await fetch(location.origin + path, { credentials: 'include' });
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const hari = hariIni(), tgl = tanggalHalaman(doc);
    if (tgl && tgl !== hari) { console.warn('[Display Antrian] tanggal data', tgl, 'bukan hari ini', hari, '- tidak dikirim'); return null; }
    if (!tgl) console.warn('[Display Antrian] kolom tanggal tidak ditemukan; mengandalkan pengecekan di server');
    return parse(doc);
  }

  async function siklus() {
    try {
      const data = [];
      const poli = await ambil(CFG.HALAMAN);
      if (poli && !poli.lab) kelompokPoli(poli.items).forEach(g => data.push(g));
      if (CFG.LAB) {
        const lab = await ambil(CFG.HALAMAN_LAB);
        if (lab && lab.lab) data.push({ poli: LAB_POLI, items: lab.items });
      }
      if (!data.length) return;
      // Kirim hanya bila data berubah, atau sebagai penanda hidup tiap 30 detik (hemat kuota Apps Script)
      const s = JSON.stringify(data);
      if (s === terakhir && Date.now() - tTerakhir < HEARTBEAT) return;
      terakhir = s;
      tTerakhir = Date.now();
      post({ data: data, tanggal: hariIni(), pengirim: PENGIRIM }, r => {
        console.log('[Display Antrian] pengirim ' + PENGIRIM + ':', data.map(d => d.poli + ':' + d.items.length).join(' | '));
        perbarui(r);
      });
    } catch (e) {
      console.warn('[Display Antrian]', e);
    }
  }

  if (CFG.UJI) {
    const u = document.createElement('div');
    u.textContent = 'MODE UJI: semua pasien dianggap Belum';
    u.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;padding:6px 12px;border-radius:6px;' +
      'background:#C0392B;color:#fff;font:600 12px verdana,sans-serif';
    document.body.appendChild(u);
  }

  if (!CFG.URL || !CFG.TOKEN) {
    const b = document.createElement('div');
    b.id = 'da-belum-diatur';
    b.textContent = 'Display Antrian belum diatur: buka menu Tampermonkey > Pengaturan Display Antrian';
    b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;padding:6px 12px;border-radius:6px;' +
      'background:#C0392B;color:#fff;font:600 12px verdana,sans-serif';
    document.body.appendChild(b);
    return;
  }

  pasangTombol();
  siklus();
  setInterval(siklus, CFG.INTERVAL);
})();
