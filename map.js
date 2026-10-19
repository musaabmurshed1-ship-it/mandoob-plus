// خريطة التتبع الحي. تستخدم Leaflet + OpenStreetMap (تُحمَّل عند الحاجة)،
// وإن تعذّر تحميلها (عدم اتصال/حجب) تعرض لوحة إحداثيات بديلة تعمل بنفس التحديثات.
import { h, icon, iconHtml } from "./lib.js";

const LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
const LEAFLET_CSS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css";
let leafletPromise;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  leafletPromise ??= new Promise((resolve, reject) => {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = LEAFLET_CSS; document.head.append(css);
    const s = document.createElement("script"); s.src = LEAFLET_JS; s.async = true;
    const timer = setTimeout(() => reject(new Error("timeout")), 7000);
    s.onload = () => { clearTimeout(timer); window.L ? resolve(window.L) : reject(new Error("no L")); };
    s.onerror = () => { clearTimeout(timer); reject(new Error("load failed")); };
    document.head.append(s);
  }).catch((e) => { leafletPromise = undefined; throw e; });
  return leafletPromise;
}

export class LiveMap {
  constructor() {
    this.el = h("div", { style: "height:100%;width:100%", "data-livemap": "1" });
    this.last = null; this.trail = []; this.map = null; this.mounted = false; this.fallback = null;
  }
  async mount() {
    if (this.mounted) { this.map?.invalidateSize(); return; }
    this.mounted = true;
    let L;
    try { L = await loadLeaflet(); } catch { return this.#showFallback(); }
    if (!this.el.isConnected && !this.el.parentNode) { this.mounted = false; return; }
    const start = this.last ? [this.last.latitude, this.last.longitude] : [24.7136, 46.6753];
    this.map = L.map(this.el, { zoomControl: true, attributionControl: true }).setView(start, 16);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(this.map);
    this.line = L.polyline(this.trail, { color: "#00BFA6", weight: 4, opacity: 0.7 }).addTo(this.map);
    this.circle = L.circle(start, { radius: 0, color: "#00BFA6", weight: 1, fillOpacity: 0.12 }).addTo(this.map);
    this.marker = L.marker(start, { icon: L.divIcon({ className: "", html: `<div class="marker-agent">${iconHtml("bike")}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }), keyboard: false }).addTo(this.map);
    this.map.on("dragstart zoomstart", () => { this.userMoved = true; });
    if (this.last) this.update(this.last, null);
    setTimeout(() => this.map?.invalidateSize(), 50);
  }
  #showFallback() {
    this.el.replaceChildren(this.fallback = h("div", { class: "map-fallback" },
      h("div", { class: "pin" }, h("i")), h("b", {}, "موقع المندوب الحالي"),
      h("code", { "data-fb-coords": "1" }, "—"), h("a", { class: "btn ghost small", target: "_blank", rel: "noopener", "data-fb-link": "1", href: "https://www.openstreetmap.org/" }, icon("pin"), "فتح في الخريطة")));
    if (this.last) this.#paintFallback();
  }
  #paintFallback() {
    if (!this.fallback || !this.last) return;
    const { latitude: la, longitude: lo } = this.last;
    this.fallback.querySelector("[data-fb-coords]").textContent = `${la.toFixed(5)}, ${lo.toFixed(5)}`;
    this.fallback.querySelector("[data-fb-link]").href = `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=17/${la}/${lo}`;
  }
  /** يستقبل أحدث موقع (ومسارًا اختياريًا) ويحرّك الدبوس دون إعادة إنشاء الخريطة. */
  update(tracking, trail) {
    if (!tracking) return;
    this.last = tracking;
    if (trail?.length) this.trail = trail.slice(-300);
    else {
      const p = [tracking.latitude, tracking.longitude], q = this.trail.at(-1);
      if (!q || q[0] !== p[0] || q[1] !== p[1]) this.trail.push(p);
      if (this.trail.length > 300) this.trail.shift();
    }
    this.#paintFallback();
    if (!this.map) return;
    const ll = [tracking.latitude, tracking.longitude];
    this.marker.setLatLng(ll); this.circle.setLatLng(ll).setRadius(tracking.accuracyMeters || 0); this.line.setLatLngs(this.trail);
    if (!this.userMoved) this.map.panTo(ll, { animate: true, duration: 0.8 });
  }
  destroy() { this.map?.remove(); this.map = null; }
}
