// Схематичные иллюстрации для инструкций: человек должен узнать экран глазами,
// а не разбирать текст. Рисуем сами — картинки не грузятся из сети и работают офлайн.

const A = 'var(--accent)';

/** Экран Google AI Studio с подсвеченной кнопкой создания ключа. */
export const studioIllustration = () => `
<svg viewBox="0 0 280 170" class="illust" aria-hidden="true">
  <rect x="4" y="4" width="272" height="162" rx="12" fill="var(--card)"/>
  <rect x="4" y="4" width="272" height="26" rx="12" fill="var(--card-2)"/>
  <rect x="4" y="20" width="272" height="10" fill="var(--card-2)"/>
  <circle cx="18" cy="17" r="4" fill="var(--muted)" opacity=".5"/>
  <rect x="30" y="13" width="90" height="8" rx="4" fill="var(--muted)" opacity=".45"/>
  <rect x="18" y="44" width="120" height="9" rx="4.5" fill="var(--muted)" opacity=".55"/>
  <rect x="18" y="62" width="180" height="7" rx="3.5" fill="var(--muted)" opacity=".3"/>
  <rect x="18" y="76" width="150" height="7" rx="3.5" fill="var(--muted)" opacity=".3"/>
  <g>
    <rect x="18" y="100" width="132" height="34" rx="17" fill="${A}"/>
    <rect x="34" y="112" width="12" height="10" rx="2" fill="#fff"/>
    <rect x="54" y="113" width="80" height="8" rx="4" fill="#fff" opacity=".95"/>
  </g>
  <g class="illust-pointer">
    <circle cx="150" cy="117" r="16" fill="${A}" opacity=".22"/>
    <path d="M150 106v14l4-3 3 7 4-2-3-7 5-1z" fill="var(--fg)"/>
  </g>
</svg>`;

/** Панель Safari с кнопкой «Поделиться». */
export const shareIllustration = () => `
<svg viewBox="0 0 280 190" class="illust" aria-hidden="true">
  <rect x="60" y="4" width="160" height="150" rx="16" fill="var(--card)"/>
  <rect x="72" y="18" width="136" height="104" rx="8" fill="var(--card-2)"/>
  <rect x="88" y="40" width="104" height="8" rx="4" fill="var(--muted)" opacity=".35"/>
  <rect x="96" y="58" width="88" height="8" rx="4" fill="var(--muted)" opacity=".25"/>
  <rect x="60" y="128" width="160" height="26" rx="0" fill="var(--card-2)"/>
  <rect x="60" y="140" width="160" height="14" rx="14" fill="var(--card-2)"/>
  <g>
    <rect x="126" y="130" width="28" height="22" rx="6" fill="${A}" opacity=".2"/>
    <path d="M140 134v11M136 138l4-4 4 4M133 141v6h14v-6" stroke="${A}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <g class="illust-pointer">
    <circle cx="140" cy="164" r="15" fill="${A}" opacity=".2"/>
    <path d="M140 154v14l4-3 3 7 4-2-3-7 5-1z" fill="var(--fg)"/>
  </g>
</svg>`;

/** Меню «Поделиться» с пунктом «На экран Домой». */
export const addHomeIllustration = () => `
<svg viewBox="0 0 280 190" class="illust" aria-hidden="true">
  <rect x="40" y="8" width="200" height="174" rx="16" fill="var(--card)"/>
  <rect x="56" y="22" width="168" height="30" rx="10" fill="var(--card-2)"/>
  <circle cx="74" cy="37" r="9" fill="var(--muted)" opacity=".3"/>
  <rect x="92" y="33" width="80" height="8" rx="4" fill="var(--muted)" opacity=".4"/>
  <rect x="56" y="62" width="168" height="26" rx="8" fill="var(--card-2)"/>
  <rect x="70" y="71" width="70" height="8" rx="4" fill="var(--muted)" opacity=".3"/>
  <g>
    <rect x="56" y="96" width="168" height="34" rx="10" fill="${A}" opacity=".16" stroke="${A}" stroke-width="1.5"/>
    <rect x="70" y="105" width="16" height="16" rx="4" stroke="${A}" stroke-width="2" fill="none"/>
    <path d="M78 109v8M74 113h8" stroke="${A}" stroke-width="2" stroke-linecap="round"/>
    <rect x="96" y="109" width="96" height="8" rx="4" fill="${A}" opacity=".75"/>
  </g>
  <rect x="56" y="140" width="168" height="26" rx="8" fill="var(--card-2)"/>
  <rect x="70" y="149" width="60" height="8" rx="4" fill="var(--muted)" opacity=".3"/>
  <g class="illust-pointer">
    <circle cx="200" cy="113" r="15" fill="${A}" opacity=".22"/>
    <path d="M200 103v14l4-3 3 7 4-2-3-7 5-1z" fill="var(--fg)"/>
  </g>
</svg>`;

/** Меню браузера на Android с пунктом «Установить приложение». */
export const androidInstallIllustration = () => `
<svg viewBox="0 0 280 190" class="illust" aria-hidden="true">
  <rect x="60" y="4" width="160" height="182" rx="16" fill="var(--card)"/>
  <rect x="72" y="16" width="136" height="20" rx="6" fill="var(--card-2)"/>
  <circle cx="198" cy="26" r="2" fill="var(--muted)"/><circle cx="198" cy="20" r="2" fill="var(--muted)"/><circle cx="198" cy="32" r="2" fill="var(--muted)"/>
  <rect x="108" y="44" width="104" height="130" rx="12" fill="var(--card-2)"/>
  <rect x="120" y="58" width="70" height="8" rx="4" fill="var(--muted)" opacity=".3"/>
  <rect x="120" y="80" width="80" height="8" rx="4" fill="var(--muted)" opacity=".3"/>
  <g>
    <rect x="112" y="98" width="96" height="28" rx="8" fill="${A}" opacity=".16"/>
    <path d="M126 106v10M122 112l4 4 4-4" stroke="${A}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="138" y="108" width="60" height="8" rx="4" fill="${A}" opacity=".75"/>
  </g>
  <rect x="120" y="140" width="66" height="8" rx="4" fill="var(--muted)" opacity=".3"/>
  <g class="illust-pointer">
    <circle cx="204" cy="26" r="14" fill="${A}" opacity=".22"/>
    <path d="M204 16v14l4-3 3 7 4-2-3-7 5-1z" fill="var(--fg)"/>
  </g>
</svg>`;

/** Что умеет приложение — три кружка на первом шаге. */
export const featuresIllustration = () => `
<svg viewBox="0 0 280 110" class="illust" aria-hidden="true">
  <g>
    <circle cx="52" cy="46" r="30" fill="${A}" opacity=".14"/>
    <path d="M52 32a6 6 0 0 1 6 6v8a6 6 0 0 1-12 0v-8a6 6 0 0 1 6-6Zm-11 14a1.6 1.6 0 0 1 1.6 1.6 9.4 9.4 0 0 0 18.8 0 1.6 1.6 0 1 1 3.2 0 12.6 12.6 0 0 1-11 12.4V64h4a1.6 1.6 0 0 1 0 3.2H47a1.6 1.6 0 0 1 0-3.2h4v-4a12.6 12.6 0 0 1-11-12.4A1.6 1.6 0 0 1 41 46Z" fill="${A}"/>
  </g>
  <g>
    <circle cx="140" cy="46" r="30" fill="${A}" opacity=".14"/>
    <rect x="124" y="34" width="32" height="26" rx="6" stroke="${A}" stroke-width="2.5" fill="none"/>
    <path d="M131 42h18M131 48h12" stroke="${A}" stroke-width="2.5" stroke-linecap="round"/>
  </g>
  <g>
    <circle cx="228" cy="46" r="30" fill="${A}" opacity=".14"/>
    <path d="M215 36h20a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4h-6l-6 5v-5h-8a4 4 0 0 1-4-4V40a4 4 0 0 1 4-4Z" fill="${A}"/>
  </g>
  <text x="52" y="96" text-anchor="middle" font-size="11" fill="var(--muted)">голосом</text>
  <text x="140" y="96" text-anchor="middle" font-size="11" fill="var(--muted)">по фото</text>
  <text x="228" y="96" text-anchor="middle" font-size="11" fill="var(--muted)">без сети</text>
</svg>`;
