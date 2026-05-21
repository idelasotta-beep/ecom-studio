/**
 * Shopify section + template builders for assembled landings.
 *
 * We install ONE section file per element type (reusable across landings) and
 * generate a per-landing JSON template that references those sections with
 * per-instance settings.
 *
 * Each section file carries a {% schema %} block so every value the user
 * configured in Ecom Studio is fully editable in the Shopify theme editor.
 *
 * Generated assets for a publish:
 *   sections/ecom-studio-image.liquid            ← landing image (one per slot)
 *   sections/ecom-studio-announcement-bar.liquid
 *   sections/ecom-studio-connector.liquid
 *   sections/ecom-studio-authority.liquid
 *   sections/ecom-studio-cta.liquid
 *   sections/ecom-studio-float-cta.liquid
 *   templates/product.ecomstudio-<id>-<ts>.json  ← per-landing template
 */
'use strict';

// ─────────────────────────────────────────────────────────────────
// Element registry
// ─────────────────────────────────────────────────────────────────

const ELEMENT_DEFS = {
  'announcement-bar': {
    sectionKey: 'ecom-studio-announcement-bar',
    placement:  'global-top',
    idPrefix:   'ann',
    liquid:     announcementBarSectionLiquid,
    settings:   announcementBarSettings,
  },
  'connector': {
    sectionKey: 'ecom-studio-connector',
    placement:  'inline',
    idPrefix:   'cn',
    liquid:     connectorSectionLiquid,
    settings:   connectorSettings,
  },
  'authority': {
    sectionKey: 'ecom-studio-authority',
    placement:  'inline',
    idPrefix:   'au',
    liquid:     authoritySectionLiquid,
    settings:   authoritySettings,
  },
  'cta': {
    sectionKey: 'ecom-studio-cta',
    placement:  'inline',
    idPrefix:   'cta',
    liquid:     ctaSectionLiquid,
    settings:   ctaSettings,
  },
  'float-cta': {
    sectionKey: 'ecom-studio-float-cta',
    placement:  'global-bottom',
    idPrefix:   'flt',
    liquid:     floatCtaSectionLiquid,
    settings:   floatCtaSettings,
  },
  'faq': {
    sectionKey: 'ecom-studio-faq',
    placement:  'inline',
    idPrefix:   'faq',
    liquid:     faqSectionLiquid,
    settings:   faqSettings,
    // FAQ uses blocks (one per Q+A pair). The element's config has a `questions`
    // array; we serialize it into Shopify schema blocks at template-build time.
    hasBlocks:  true,
    buildBlocks: faqBuildBlocks,
  },
  'stats': {
    sectionKey:  'ecom-studio-stats',
    placement:   'inline',
    idPrefix:    'st',
    liquid:      statsSectionLiquid,
    settings:    statsSettings,
    hasBlocks:   true,
    buildBlocks: statsBuildBlocks,
  },
  'comparison': {
    sectionKey:  'ecom-studio-comparison',
    placement:   'inline',
    idPrefix:    'cmp',
    liquid:      comparisonSectionLiquid,
    settings:    comparisonSettings,
    hasBlocks:   true,
    buildBlocks: comparisonBuildBlocks,
  },
  'features': {
    sectionKey:  'ecom-studio-features',
    placement:   'inline',
    idPrefix:    'ft',
    liquid:      featuresSectionLiquid,
    settings:    featuresSettings,
    hasBlocks:   true,
    buildBlocks: featuresBuildBlocks,
  },
  'testimonials': {
    sectionKey:  'ecom-studio-testimonials',
    placement:   'inline',
    idPrefix:    'tm',
    liquid:      testimonialsSectionLiquid,
    settings:    testimonialsSettings,
    hasBlocks:   true,
    buildBlocks: testimonialsBuildBlocks,
  },
  'countdown': {
    sectionKey: 'ecom-studio-countdown',
    placement:  'inline',
    idPrefix:   'cnt',
    liquid:     countdownSectionLiquid,
    settings:   countdownSettings,
  },
  'stock-bar': {
    sectionKey: 'ecom-studio-stock-bar',
    placement:  'inline',
    idPrefix:   'stk',
    liquid:     stockBarSectionLiquid,
    settings:   stockBarSettings,
  },
  'trust-badges': {
    sectionKey:  'ecom-studio-trust-badges',
    placement:   'inline',
    idPrefix:    'trb',
    liquid:      trustBadgesSectionLiquid,
    settings:    trustBadgesSettings,
    hasBlocks:   true,
    buildBlocks: trustBadgesBuildBlocks,
  },
  'live-social': {
    sectionKey: 'ecom-studio-live-social',
    placement:  'inline',
    idPrefix:   'lsp',
    liquid:     liveSocialSectionLiquid,
    settings:   liveSocialSettings,
  },
  'live-viewers': {
    sectionKey: 'ecom-studio-live-viewers',
    placement:  'inline',
    idPrefix:   'lvw',
    liquid:     liveViewersSectionLiquid,
    settings:   liveViewersSettings,
  },
  'shipping-clock': {
    sectionKey: 'ecom-studio-shipping-clock',
    placement:  'inline',
    idPrefix:   'shp',
    liquid:     shippingClockSectionLiquid,
    settings:   shippingClockSettings,
  },
  'purchase-popup': {
    sectionKey:  'ecom-studio-purchase-popup',
    placement:   'global-bottom',
    idPrefix:    'pup',
    liquid:      purchasePopupSectionLiquid,
    settings:    purchasePopupSettings,
    hasBlocks:   true,
    buildBlocks: purchasePopupBuildBlocks,
  },
  'product-hero': {
    sectionKey: 'ecom-studio-product-hero',
    placement:  'inline',
    idPrefix:   'phr',
    liquid:     productHeroSectionLiquid,
    settings:   productHeroSettings,
  },
};

const IMAGE_SECTION = {
  sectionKey: 'ecom-studio-image',
  idPrefix:   'img',
};

// Reusable Liquid snippet — emitted inside CTA/float-cta when action=releaseit.
// Self-guards via window.__ecomStudioReleasitBound so multiple embeds are safe.
const RELEASIT_BOOTSTRAP_LIQUID = `<script>
(function(){
  'use strict';
  if (window.__ecomStudioReleasitBound) return;
  window.__ecomStudioReleasitBound = true;
  function openReleasitCodForm(){
    try { if (window._rsiV2 && typeof _rsiV2.setState==='function') { _rsiV2.setState({isOpen:true}); return true; } } catch(e){ console.warn('[Ecom Studio] _rsiV2 fail:', e); }
    try { if (window._rsi && _rsi.form && typeof _rsi.form.open==='function') { _rsi.form.open(); return true; } } catch(e){ console.warn('[Ecom Studio] _rsi.form fail:', e); }
    try { var f=document.getElementById('rsi_buy_now_button'); if (f) { f.click(); return true; } } catch(e){ console.warn('[Ecom Studio] dom fail:', e); }
    return false;
  }
  var inflight=false;
  function openWhenReady(maxMs){
    if (inflight) return; inflight=true; maxMs=maxMs||4000; var t0=Date.now();
    (function attempt(){
      if (openReleasitCodForm()){ inflight=false; return; }
      if (Date.now()-t0>maxMs){ inflight=false; console.warn('[Ecom Studio] Releasit COD form no disponible.'); return; }
      setTimeout(attempt, 100);
    })();
  }
  function handle(ev){ var b=ev.currentTarget; if (!b || b.getAttribute('data-action')!=='releasit_cod') return; ev.preventDefault(); ev.stopImmediatePropagation(); openWhenReady(); }
  function bind(){ var n=document.querySelectorAll('[data-action="releasit_cod"]'); for (var i=0;i<n.length;i++){ var el=n[i]; if (el.__ecomStudioReleasitBoundEl) continue; el.__ecomStudioReleasitBoundEl=true; el.addEventListener('click', handle, true); } }
  bind();
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', bind);
  new MutationObserver(bind).observe(document.body, { childList:true, subtree:true });
})();
</script>`;

// Helper for the AJAX-checkout redirect (used by shopify_checkout action).
function ajaxCheckoutLiquidSnippet(formId) {
  return `<script>
(function(){
  var f = document.getElementById('${formId}');
  if (!f) return;
  f.addEventListener('submit', function(ev){
    ev.preventDefault();
    fetch('/cart/add.js', { method:'POST', body: new FormData(f) })
      .then(function(r){ return r.json(); })
      .then(function(){ window.location.href = '/checkout'; })
      .catch(function(){ window.location.href = '/cart'; });
  });
})();
</script>`;
}

// ─────────────────────────────────────────────────────────────────
// Settings mappers — config (from DB) → schema-typed settings (for template JSON)
// ─────────────────────────────────────────────────────────────────

function num(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }
function str(v, def) { return (v == null || v === '') ? def : String(v); }
function bool(v) { return !!v; }
function hex(v, def) { return (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : def; }

// ─────────────────────────────────────────────────────────────────
// Shared Lucide-style icon set (used by Features element + frontend mirror)
// All paths are stroke-only, currentColor, viewBox=24
// ─────────────────────────────────────────────────────────────────
const ICON_SET = {
  check:     '<polyline points="20 6 9 17 4 12"/>',
  star:      '<polygon points="12 2 15 8.5 22 9.3 17 14 18 21 12 17.8 6 21 7 14 2 9.3 9 8.5 12 2"/>',
  shield:    '<path d="M12 2L4 5v6c0 5 3.5 9.7 8 11 4.5-1.3 8-6 8-11V5l-8-3z"/>',
  heart:     '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  truck:     '<rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  zap:       '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  leaf:      '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19.2 2.5c1 1.5.5 7-2 11.5-2.5 4.5-6 6-9.2 6z"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/>',
  droplet:   '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
  sparkles:  '<path d="M12 3l1.91 5.84L20 11l-6.09 2.16L12 19l-1.91-5.84L4 11l6.09-2.16L12 3z"/><path d="M5 3v4M3 5h4M19 17v4M17 19h4"/>',
  flame:     '<path d="M12 22a7 7 0 0 1-7-7c0-3 1.5-5.5 4-7 0 2 1 4 3 4s4-1 4-4c2.5 1.5 4 4 4 7a7 7 0 0 1-7 7z"/>',
  award:     '<circle cx="12" cy="8" r="6"/><polyline points="8.21 13.89 7 22 12 19 17 22 15.79 13.88"/>',
  gift:      '<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
  clock:     '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  flask:     '<path d="M10 2v7.31"/><path d="M14 9.3V1.99"/><path d="M8.5 2h7"/><path d="M14 9.3a6.5 6.5 0 1 1-4 0"/>',
  sun:       '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M17.66 17.66l1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M6.34 17.66l-1.41 1.41"/><path d="M19.07 4.93l-1.41 1.41"/>',
  'thumbs-up': '<path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>',
  target:    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  flower:    '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="12" r="3"/>',
  package:   '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  dollar:    '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
};
const ICON_KEYS = Object.keys(ICON_SET);
function icon(v, def) { return (typeof v === 'string' && ICON_SET[v]) ? v : def; }

function announcementBarSettings(c) {
  return {
    anchor_id:      str(c.anchor_id, 'announcement-bar'),
    sticky:         bool(c.sticky),
    text:           str(c.text, ''),
    uppercase:      bool(c.uppercase),
    bg_color:       hex(c.bg_color, '#000000'),
    use_gradient:   bool(c.use_gradient),
    bg_gradient_to: hex(c.bg_gradient_to, hex(c.bg_color, '#000000')),
    text_color:     hex(c.text_color, '#FFFFFF'),
    font_family:    str(c.font_family, 'system-ui'),
    font_size:      num(c.font_size, 14),
    font_weight:    String(num(c.font_weight, 500)),
    letter_spacing: num(c.letter_spacing, 0),
    max_width:      num(c.max_width, 1200),
    padding_v:      num(c.padding_v, 15),
    padding_h:      num(c.padding_h, 20),
  };
}

function connectorSettings(c) {
  return {
    variant:           (c.variant === 'gradient') ? 'gradient' : 'highlighted',
    max_width:         num(c.max_width, 1200),
    pad_x:             num(c.pad_x, 20),
    pad_top:           num(c.pad_top, 10),
    pad_bottom:        num(c.pad_bottom, 10),
    text:              str(c.text, ''),
    uppercase:         bool(c.uppercase),
    bg_color:          hex(c.bg_color, '#000000'),
    text_color:        hex(c.text_color, '#FFFFFF'),
    font_size:         num(c.font_size, 14),
    font_weight:       String(num(c.font_weight, 700)),
    letter_spacing:    num(c.letter_spacing, 0),
    grad_color_top:    hex(c.grad_color_top, '#000000'),
    grad_color_bottom: hex(c.grad_color_bottom, '#FFFFFF'),
    grad_height:       num(c.grad_height, 60),
  };
}

function authoritySettings(c) {
  return {
    image_url:  str(c.image_url, ''),
    alt:        '',
    max_width:  num(c.max_width, 1200),
    img_width:  num(c.img_width, 720),
    pad_x:      num(c.pad_x, 20),
    pad_top:    num(c.pad_top, 10),
    pad_bottom: num(c.pad_bottom, 10),
    bg_color:   hex(c.bg_color, '#FFFFFF'),
  };
}

function ctaCommonSettings(c) {
  return {
    action_type:     str(c.action_type, 'shopify_checkout'),
    custom_url:      str(c.custom_url, ''),
    text:            str(c.text, 'COMPRAR AHORA'),
    bg_color:        hex(c.bg_color, '#000000'),
    text_color:      hex(c.text_color, '#FFFFFF'),
    font_family:     str(c.font_family, 'system-ui'),
    text_style:      str(c.text_style, 'uppercase'),
    bold:            (c.bold == null) ? true : bool(c.bold),
    font_size:       num(c.font_size, 16),
    letter_spacing:  num(c.letter_spacing, 0.5),
    btn_pad_y:       num(c.btn_pad_y, 15),
    border_radius:   num(c.border_radius, 10),
    logo_top_url:    str(c.logo_top_url, ''),
    logo_bottom_url: str(c.logo_bottom_url, ''),
    pad_top:         num(c.pad_top, 10),
    pad_bottom:      num(c.pad_bottom, 10),
    pad_x:           num(c.pad_x, 20),
    bar_bg_color:    hex(c.bar_bg_color, '#FFFFFF'),
  };
}

function ctaSettings(c) {
  return {
    ...ctaCommonSettings(c),
    max_width:       num(c.max_width, 1200),
    use_gradient:    bool(c.use_gradient),
    bar_grad_top:    hex(c.bar_grad_top, '#000000'),
    bar_grad_bottom: hex(c.bar_grad_bottom, '#FFFFFF'),
  };
}

function floatCtaSettings(c) {
  return {
    ...ctaCommonSettings(c),
    max_width:        num(c.max_width, 1200),
    scroll_threshold: num(c.scroll_threshold, 300),
  };
}

function faqSettings(c) {
  return {
    title:               str(c.title, 'Preguntas Frecuentes'),
    show_title:          (c.show_title == null) ? true : bool(c.show_title),
    title_color:         hex(c.title_color, '#000000'),
    title_size:          num(c.title_size, 28),
    title_align:         (c.title_align === 'left' || c.title_align === 'right') ? c.title_align : 'center',
    bg_color:            hex(c.bg_color, '#FFFFFF'),
    max_width:           num(c.max_width, 880),  // narrower than images by default; readable for text
    pad_top:             num(c.pad_top, 40),
    pad_bottom:          num(c.pad_bottom, 40),
    pad_x:               num(c.pad_x, 20),
    item_bg:             hex(c.item_bg, '#F8F8F8'),
    item_border_color:   hex(c.item_border_color, '#E5E5E5'),
    item_text_color:     hex(c.item_text_color, '#111111'),
    item_question_color: hex(c.item_question_color, '#000000'),
    item_border_radius:  num(c.item_border_radius, 8),
    item_gap:            num(c.item_gap, 8),
    item_padding:        num(c.item_padding, 16),
  };
}

function statsSettings(c) {
  return {
    title:           str(c.title, 'Resultados que hablan por sí solos'),
    show_title:      (c.show_title == null) ? true : bool(c.show_title),
    title_color:     hex(c.title_color, '#000000'),
    title_size:      num(c.title_size, 28),
    title_align:     (c.title_align === 'left' || c.title_align === 'right') ? c.title_align : 'center',
    bg_color:        hex(c.bg_color, '#FFFFFF'),
    max_width:       num(c.max_width, 1200),
    pad_top:         num(c.pad_top, 40),
    pad_bottom:      num(c.pad_bottom, 40),
    pad_x:           num(c.pad_x, 20),
    layout:          (c.layout === 'list') ? 'list' : 'grid',
    columns:         Math.min(4, Math.max(2, num(c.columns, 3))),
    item_gap:        num(c.item_gap, 16),
    show_dividers:   bool(c.show_dividers),
    divider_color:   hex(c.divider_color, '#E5E5E5'),
    badge_style:     ['ring', 'filled', 'none'].includes(c.badge_style) ? c.badge_style : 'none',
    badge_color:     hex(c.badge_color, '#F59E0B'),
    badge_bg:        hex(c.badge_bg, '#FFFFFF'),
    badge_size:      num(c.badge_size, 80),
    badge_border:    num(c.badge_border, 4),
    number_color:    hex(c.number_color, '#F59E0B'),
    number_size:     num(c.number_size, 22),
    label_color:     hex(c.label_color, '#111111'),
    label_size:      num(c.label_size, 16),
    desc_color:      hex(c.desc_color, '#666666'),
    desc_size:       num(c.desc_size, 13),
  };
}

function comparisonSettings(c) {
  return {
    title:           str(c.title, 'Lo que nos hace diferentes'),
    show_title:      (c.show_title == null) ? true : bool(c.show_title),
    title_color:     hex(c.title_color, '#000000'),
    title_size:      num(c.title_size, 28),
    title_align:     (c.title_align === 'left' || c.title_align === 'right') ? c.title_align : 'left',
    description:     str(c.description, ''),
    desc_color:      hex(c.desc_color, '#444444'),
    desc_size:       num(c.desc_size, 15),
    title_table_gap: num(c.title_table_gap, 24),
    layout:          (c.layout === 'side_by_side') ? 'side_by_side' : 'stacked',
    bg_color:        hex(c.bg_color, '#FFFFFF'),
    max_width:       num(c.max_width, 1200),
    pad_top:         num(c.pad_top, 40),
    pad_bottom:      num(c.pad_bottom, 40),
    pad_x:           num(c.pad_x, 20),
    our_label:       str(c.our_label, 'Nuestro producto'),
    their_label:     str(c.their_label, 'Otros'),
    header_color:    hex(c.header_color, '#999999'),
    header_size:     num(c.header_size, 13),
    header_nowrap:   (c.header_nowrap == null) ? false : bool(c.header_nowrap),
    criteria_col_width: Math.min(70, Math.max(30, num(c.criteria_col_width, 50))),
    criteria_bg:     hex(c.criteria_bg, '#F59E0B'),
    criteria_color:  hex(c.criteria_color, '#FFFFFF'),
    cell_bg:         hex(c.cell_bg, '#FFFFFF'),
    row_border:      hex(c.row_border, '#F0F0F0'),
    table_border:    hex(c.table_border, '#E5E5E5'),
    table_radius:    num(c.table_radius, 12),
    cell_padding:    num(c.cell_padding, 14),
    label_size:      num(c.label_size, 14),
    label_weight:    String(num(c.label_weight, 700)),
    check_color:     hex(c.check_color, '#22C55E'),
    cross_color:     hex(c.cross_color, '#9CA3AF'),
    icon_size:       num(c.icon_size, 22),
  };
}

function featuresSettings(c) {
  return {
    title:          str(c.title, '¿Por qué elegirnos?'),
    show_title:     (c.show_title == null) ? true : bool(c.show_title),
    title_color:    hex(c.title_color, '#000000'),
    title_size:     num(c.title_size, 28),
    title_align:    (c.title_align === 'left' || c.title_align === 'right') ? c.title_align : 'center',
    description:    str(c.description, ''),
    desc_color:     hex(c.desc_color, '#444444'),
    desc_size:      num(c.desc_size, 15),
    title_grid_gap: num(c.title_grid_gap, 32),
    bg_color:       hex(c.bg_color, '#FFFFFF'),
    max_width:      num(c.max_width, 1200),
    pad_top:        num(c.pad_top, 40),
    pad_bottom:     num(c.pad_bottom, 40),
    pad_x:          num(c.pad_x, 20),
    columns:        Math.min(4, Math.max(1, num(c.columns, 3))),
    item_gap:       num(c.item_gap, 24),
    item_align:     (c.item_align === 'left' || c.item_align === 'right') ? c.item_align : 'center',
    icon_style:     ['plain', 'circle', 'square'].includes(c.icon_style) ? c.icon_style : 'circle',
    icon_color:     hex(c.icon_color, '#F59E0B'),
    icon_bg:        hex(c.icon_bg, '#FEF3C7'),
    icon_size:      num(c.icon_size, 28),
    badge_size:     num(c.badge_size, 56),
    badge_radius:   Math.min(60, Math.max(0, num(c.badge_radius, 12))),
    ft_title_color: hex(c.ft_title_color, '#111111'),
    ft_title_size:  num(c.ft_title_size, 17),
    ft_title_weight: String(num(c.ft_title_weight, 700)),
    ft_desc_color:  hex(c.ft_desc_color, '#555555'),
    ft_desc_size:   num(c.ft_desc_size, 14),
  };
}

function testimonialsSettings(c) {
  return {
    title:          str(c.title, 'Lo que dicen nuestros clientes'),
    show_title:     (c.show_title == null) ? true : bool(c.show_title),
    title_color:    hex(c.title_color, '#000000'),
    title_size:     num(c.title_size, 28),
    title_align:    (c.title_align === 'left' || c.title_align === 'right') ? c.title_align : 'center',
    description:    str(c.description, ''),
    desc_color:     hex(c.desc_color, '#444444'),
    desc_size:      num(c.desc_size, 15),
    title_grid_gap: num(c.title_grid_gap, 32),
    bg_color:       hex(c.bg_color, '#FFFFFF'),
    max_width:      num(c.max_width, 1200),
    pad_top:        num(c.pad_top, 40),
    pad_bottom:     num(c.pad_bottom, 40),
    pad_x:          num(c.pad_x, 20),
    columns:        Math.min(4, Math.max(1, num(c.columns, 3))),
    item_gap:       num(c.item_gap, 20),
    card_bg:        hex(c.card_bg, '#FAFAFA'),
    card_border:    hex(c.card_border, '#EEEEEE'),
    card_radius:    num(c.card_radius, 14),
    card_padding:   num(c.card_padding, 22),
    show_avatar:    (c.show_avatar == null) ? true : bool(c.show_avatar),
    avatar_size:    num(c.avatar_size, 44),
    avatar_bg:      hex(c.avatar_bg, '#F59E0B'),
    avatar_color:   hex(c.avatar_color, '#FFFFFF'),
    show_stars:     (c.show_stars == null) ? true : bool(c.show_stars),
    star_color:     hex(c.star_color, '#F59E0B'),
    star_size:      num(c.star_size, 16),
    name_color:     hex(c.name_color, '#111111'),
    name_size:      num(c.name_size, 15),
    loc_color:      hex(c.loc_color, '#888888'),
    loc_size:       num(c.loc_size, 12),
    text_color:     hex(c.text_color, '#444444'),
    text_size:      num(c.text_size, 14),
    text_italic:    bool(c.text_italic),
  };
}

function countdownSettings(c) {
  return {
    title:           str(c.title, '¡Oferta por tiempo limitado!'),
    show_title:      (c.show_title == null) ? true : bool(c.show_title),
    title_color:     hex(c.title_color, '#000000'),
    title_size:      num(c.title_size, 20),
    title_align:     (c.title_align === 'left' || c.title_align === 'right') ? c.title_align : 'center',
    mode:            (c.mode === 'fixed') ? 'fixed' : 'evergreen',
    target_date:     str(c.target_date, ''),
    duration_hours:  Math.min(100, Math.max(1, num(c.duration_hours, 24))),
    show_days:       (c.show_days == null) ? true : bool(c.show_days),
    show_hours:      (c.show_hours == null) ? true : bool(c.show_hours),
    show_minutes:    (c.show_minutes == null) ? true : bool(c.show_minutes),
    show_seconds:    (c.show_seconds == null) ? true : bool(c.show_seconds),
    label_days:      str(c.label_days, 'Días'),
    label_hours:     str(c.label_hours, 'Horas'),
    label_minutes:   str(c.label_minutes, 'Minutos'),
    label_seconds:   str(c.label_seconds, 'Segundos'),
    show_unit_labels:(c.show_unit_labels == null) ? true : bool(c.show_unit_labels),
    box_style:       ['filled', 'outline', 'minimal'].includes(c.box_style) ? c.box_style : 'filled',
    box_bg:          hex(c.box_bg, '#000000'),
    box_color:       hex(c.box_color, '#FFFFFF'),
    box_border:      hex(c.box_border, '#000000'),
    box_size:        num(c.box_size, 36),
    box_width:       num(c.box_width, 70),
    box_height:      num(c.box_height, 80),
    box_radius:      Math.min(24, Math.max(0, num(c.box_radius, 8))),
    box_gap:         num(c.box_gap, 8),
    separator:       str(c.separator, ''),
    unit_label_color:hex(c.unit_label_color, '#666666'),
    unit_label_size: num(c.unit_label_size, 11),
    expired_text:    str(c.expired_text, '¡La oferta ha terminado!'),
    expired_color:   hex(c.expired_color, '#EF4444'),
    bg_color:        hex(c.bg_color, '#FFFFFF'),
    max_width:       num(c.max_width, 1200),
    pad_top:         num(c.pad_top, 20),
    pad_bottom:      num(c.pad_bottom, 20),
    pad_x:           num(c.pad_x, 20),
  };
}

function stockBarSettings(c) {
  return {
    title:           str(c.title, '¡Stock limitado!'),
    show_title:      (c.show_title == null) ? true : bool(c.show_title),
    title_color:     hex(c.title_color, '#000000'),
    title_size:      num(c.title_size, 18),
    title_align:     (c.title_align === 'left' || c.title_align === 'right') ? c.title_align : 'left',
    show_alert_icon: (c.show_alert_icon == null) ? true : bool(c.show_alert_icon),
    alert_icon_color:hex(c.alert_icon_color, '#EF4444'),
    message:         str(c.message, 'Solo quedan {count} unidades disponibles'),
    message_color:   hex(c.message_color, '#444444'),
    message_size:    num(c.message_size, 14),
    stock_count:     Math.max(0, num(c.stock_count, 7)),
    bar_percent:     Math.min(100, Math.max(0, num(c.bar_percent, 18))),
    bar_height:      Math.min(40, Math.max(4, num(c.bar_height, 10))),
    bar_radius:      Math.min(40, Math.max(0, num(c.bar_radius, 20))),
    bar_bg:          hex(c.bar_bg, '#F0F0F0'),
    bar_fill:        hex(c.bar_fill, '#EF4444'),
    bar_fill_to:     hex(c.bar_fill_to, '#EF4444'),
    use_gradient:    bool(c.use_gradient),
    animate_on_load: (c.animate_on_load == null) ? true : bool(c.animate_on_load),
    pulse:           bool(c.pulse),
    bg_color:        hex(c.bg_color, '#FFFFFF'),
    max_width:       num(c.max_width, 1200),
    pad_top:         num(c.pad_top, 16),
    pad_bottom:      num(c.pad_bottom, 16),
    pad_x:           num(c.pad_x, 20),
  };
}

function trustBadgesSettings(c) {
  return {
    title:           str(c.title, ''),
    show_title:      (c.show_title == null) ? false : bool(c.show_title),
    title_color:     hex(c.title_color, '#000000'),
    title_size:      num(c.title_size, 20),
    title_align:     (c.title_align === 'left' || c.title_align === 'right') ? c.title_align : 'center',
    title_grid_gap:  num(c.title_grid_gap, 20),
    layout:          (c.layout === 'grid') ? 'grid' : 'horizontal',
    columns:         Math.min(6, Math.max(2, num(c.columns, 4))),
    item_gap:        num(c.item_gap, 20),
    item_direction:  (c.item_direction === 'horizontal') ? 'horizontal' : 'vertical',
    item_align:      (c.item_align === 'left' || c.item_align === 'right') ? c.item_align : 'center',
    icon_style:      ['plain', 'circle', 'square'].includes(c.icon_style) ? c.icon_style : 'plain',
    icon_color:      hex(c.icon_color, '#000000'),
    icon_bg:         hex(c.icon_bg, '#F5F5F5'),
    icon_size:       num(c.icon_size, 28),
    badge_size:      num(c.badge_size, 48),
    badge_radius:    Math.min(60, Math.max(0, num(c.badge_radius, 12))),
    label_color:     hex(c.label_color, '#111111'),
    label_size:      num(c.label_size, 13),
    label_weight:    String(num(c.label_weight, 600)),
    bg_color:        hex(c.bg_color, '#FFFFFF'),
    max_width:       num(c.max_width, 1200),
    pad_top:         num(c.pad_top, 24),
    pad_bottom:      num(c.pad_bottom, 24),
    pad_x:           num(c.pad_x, 20),
  };
}

function liveSocialSettings(c) {
  return {
    message_template:  str(c.message_template, '{count} personas de {city} compraron {product} hoy {date}. Apúrate, solo quedan {stock} unidades en stock.'),
    count_min:         Math.min(100, Math.max(1, num(c.count_min, 8))),
    count_max:         Math.min(100, Math.max(1, num(c.count_max, 30))),
    stock_min:         Math.min(100, Math.max(1, num(c.stock_min, 12))),
    stock_max:         Math.min(100, Math.max(1, num(c.stock_max, 38))),
    refresh_seconds:   Math.min(300, Math.max(0, num(c.refresh_seconds, 0))),
    detect_ip:         (c.detect_ip == null) ? true : bool(c.detect_ip),
    default_city:      str(c.default_city, 'tu ciudad'),
    fallback_cities:   str(c.fallback_cities, 'Santiago, Buenos Aires, Lima, Bogotá, Ciudad de México, Madrid'),
    use_product_name:  (c.use_product_name == null) ? true : bool(c.use_product_name),
    product_manual:    str(c.product_manual, ''),
    date_format:       ['long','date_only','short','simple'].includes(c.date_format) ? c.date_format : 'long',
    variant:           ['pill','banner','card','line'].includes(c.variant) ? c.variant : 'pill',
    show_icon:         (c.show_icon == null) ? true : bool(c.show_icon),
    icon:              icon(c.icon, 'flame'),
    icon_position:     (c.icon_position === 'top') ? 'top' : 'left',
    icon_color:        hex(c.icon_color, '#EF4444'),
    icon_size:         num(c.icon_size, 18),
    bg_color:          hex(c.bg_color, '#FEF3C7'),
    text_color:        hex(c.text_color, '#111111'),
    accent_color:      hex(c.accent_color, '#EF4444'),
    accent_weight:     String(num(c.accent_weight, 700)),
    border_color:      hex(c.border_color, '#F59E0B'),
    border_width:      Math.min(4, Math.max(0, num(c.border_width, 1))),
    border_radius:     Math.min(40, Math.max(0, num(c.border_radius, 12))),
    font_size:         num(c.font_size, 14),
    font_weight:       String(num(c.font_weight, 500)),
    text_align:        (c.text_align === 'left' || c.text_align === 'right') ? c.text_align : 'center',
    padding_v:         num(c.padding_v, 12),
    padding_h:         num(c.padding_h, 18),
    animation:         ['none','fade','slide-up'].includes(c.animation) ? c.animation : 'fade',
    sec_bg_color:      hex(c.sec_bg_color, '#FFFFFF'),
    max_width:         num(c.max_width, 1200),
    pad_top:           num(c.pad_top, 16),
    pad_bottom:        num(c.pad_bottom, 16),
    pad_x:             num(c.pad_x, 20),
  };
}

function liveViewersSettings(c) {
  return {
    template:        str(c.template, '{count} personas viendo este producto ahora'),
    count_min:       Math.min(100, Math.max(1, num(c.count_min, 5))),
    count_max:       Math.min(100, Math.max(1, num(c.count_max, 25))),
    refresh_seconds: Math.min(60, Math.max(3, num(c.refresh_seconds, 12))),
    drift:           Math.min(5, Math.max(0, num(c.drift, 2))),
    show_dot:        (c.show_dot == null) ? true : bool(c.show_dot),
    dot_color:       hex(c.dot_color, '#EF4444'),
    dot_size:        num(c.dot_size, 8),
    dot_pulse:       (c.dot_pulse == null) ? true : bool(c.dot_pulse),
    variant:         ['pill','line','banner'].includes(c.variant) ? c.variant : 'pill',
    bg_color:        hex(c.bg_color, '#FEF2F2'),
    text_color:      hex(c.text_color, '#111111'),
    accent_color:    hex(c.accent_color, '#EF4444'),
    accent_weight:   String(num(c.accent_weight, 700)),
    border_color:    hex(c.border_color, '#FCA5A5'),
    border_width:    Math.min(4, Math.max(0, num(c.border_width, 1))),
    border_radius:   Math.min(40, Math.max(0, num(c.border_radius, 12))),
    font_size:       num(c.font_size, 13),
    font_weight:     String(num(c.font_weight, 500)),
    text_align:      (c.text_align === 'left' || c.text_align === 'right') ? c.text_align : 'center',
    padding_v:       num(c.padding_v, 8),
    padding_h:       num(c.padding_h, 14),
    animation:       ['none','fade','slide-up'].includes(c.animation) ? c.animation : 'fade',
    sec_bg_color:    hex(c.sec_bg_color, '#FFFFFF'),
    max_width:       num(c.max_width, 1200),
    pad_top:         num(c.pad_top, 12),
    pad_bottom:      num(c.pad_bottom, 12),
    pad_x:           num(c.pad_x, 20),
  };
}

function shippingClockSettings(c) {
  return {
    cutoff_hour:     Math.min(23, Math.max(0, num(c.cutoff_hour, 17))),
    cutoff_minute:   Math.min(59, Math.max(0, num(c.cutoff_minute, 0))),
    skip_weekends:   bool(c.skip_weekends),
    before_message:  str(c.before_message, 'Pedí en las próximas {time} y recibilo mañana'),
    after_message:   str(c.after_message,  'Hoy ya cerramos. Comprá ahora y te llega pasado mañana'),
    show_icon:       (c.show_icon == null) ? true : bool(c.show_icon),
    icon:            icon(c.icon, 'truck'),
    icon_color:      hex(c.icon_color, '#10B981'),
    icon_size:       num(c.icon_size, 18),
    variant:         ['pill','banner','card','line'].includes(c.variant) ? c.variant : 'pill',
    bg_color:        hex(c.bg_color, '#ECFDF5'),
    text_color:      hex(c.text_color, '#111111'),
    accent_color:    hex(c.accent_color, '#10B981'),
    accent_weight:   String(num(c.accent_weight, 700)),
    border_color:    hex(c.border_color, '#10B981'),
    border_width:    Math.min(4, Math.max(0, num(c.border_width, 1))),
    border_radius:   Math.min(40, Math.max(0, num(c.border_radius, 12))),
    font_size:       num(c.font_size, 14),
    font_weight:     String(num(c.font_weight, 500)),
    text_align:      (c.text_align === 'left' || c.text_align === 'right') ? c.text_align : 'center',
    padding_v:       num(c.padding_v, 12),
    padding_h:       num(c.padding_h, 18),
    sec_bg_color:    hex(c.sec_bg_color, '#FFFFFF'),
    max_width:       num(c.max_width, 1200),
    pad_top:         num(c.pad_top, 16),
    pad_bottom:      num(c.pad_bottom, 16),
    pad_x:           num(c.pad_x, 20),
  };
}

function purchasePopupSettings(c) {
  return {
    message_template:      str(c.message_template, '{name} de {city} compró {product} hace {time}'),
    position:              ['bottom-left','bottom-right','top-left','top-right'].includes(c.position) ? c.position : 'bottom-left',
    initial_delay_seconds: Math.min(30, Math.max(0, num(c.initial_delay_seconds, 5))),
    visible_seconds:       Math.min(15, Math.max(2, num(c.visible_seconds, 5))),
    hidden_seconds:        Math.min(60, Math.max(3, num(c.hidden_seconds, 12))),
    max_cycles:            Math.min(50, Math.max(0, num(c.max_cycles, 0))),
    random_order:          (c.random_order == null) ? true : bool(c.random_order),
    // Schema uses step 5 — snap saved values to the nearest valid step (clamp 0-180).
    time_ago_min:          Math.round(Math.min(180, Math.max(0, num(c.time_ago_min, 5))) / 5) * 5,
    time_ago_max:          Math.round(Math.min(180, Math.max(0, num(c.time_ago_max, 30))) / 5) * 5,
    use_product_name:      (c.use_product_name == null) ? true : bool(c.use_product_name),
    product_manual:        str(c.product_manual, ''),
    show_avatar:           (c.show_avatar == null) ? true : bool(c.show_avatar),
    avatar_bg:             hex(c.avatar_bg, '#F59E0B'),
    avatar_color:          hex(c.avatar_color, '#FFFFFF'),
    avatar_size:           num(c.avatar_size, 38),
    show_close:            (c.show_close == null) ? true : bool(c.show_close),
    close_color:           hex(c.close_color, '#999999'),
    show_icon:             bool(c.show_icon),
    icon:                  icon(c.icon, 'package'),
    icon_color:            hex(c.icon_color, '#22C55E'),
    icon_size:             num(c.icon_size, 16),
    card_bg:               hex(c.card_bg, '#FFFFFF'),
    card_border:           hex(c.card_border, '#E5E7EB'),
    card_border_width:     Math.min(4, Math.max(0, num(c.card_border_width, 1))),
    card_radius:           Math.min(32, Math.max(0, num(c.card_radius, 12))),
    card_padding:          num(c.card_padding, 14),
    card_width:            num(c.card_width, 320),
    name_color:            hex(c.name_color, '#111111'),
    name_size:             num(c.name_size, 14),
    name_weight:           String(num(c.name_weight, 700)),
    text_color:            hex(c.text_color, '#444444'),
    text_size:             num(c.text_size, 12),
    time_color:            hex(c.time_color, '#888888'),
    time_size:             num(c.time_size, 11),
    animation:             ['fade','slide-in-left','slide-in-right','slide-in-up'].includes(c.animation) ? c.animation : 'slide-in-left',
    offset_x:              Math.min(80, Math.max(0, num(c.offset_x, 16))),
    offset_y:              Math.min(80, Math.max(0, num(c.offset_y, 16))),
    z_index:               Math.min(9999, Math.max(1, num(c.z_index, 100))),
  };
}

function productHeroSettings(c) {
  return {
    // Rating
    show_rating:        (c.show_rating == null) ? true : bool(c.show_rating),
    rating:             Math.min(5, Math.max(0, num(c.rating, 5))),
    review_count:       num(c.review_count, 287),
    review_format:      str(c.review_format, '{count} reseñas'),
    star_color:         hex(c.star_color, '#F59E0B'),
    star_size:          num(c.star_size, 16),

    // Título y subtítulo
    use_product_name:   (c.use_product_name == null) ? true : bool(c.use_product_name),
    title_manual:       str(c.title_manual, ''),
    title_color:        hex(c.title_color, '#000000'),
    title_size:         num(c.title_size, 32),
    title_weight:       String(num(c.title_weight, 800)),
    subtitle:           str(c.subtitle, ''),
    subtitle_color:     hex(c.subtitle_color, '#111111'),
    subtitle_size:      num(c.subtitle_size, 16),
    subtitle_weight:    String(num(c.subtitle_weight, 700)),

    // Beneficios (textarea, una línea por beneficio)
    benefits:           str(c.benefits, 'Beneficio 1\nBeneficio 2\nBeneficio 3\nBeneficio 4'),
    benefit_color:      hex(c.benefit_color, '#111111'),
    benefit_size:       num(c.benefit_size, 15),
    check_color:        hex(c.check_color, '#22C55E'),
    check_size:         num(c.check_size, 18),

    // Precio
    show_price:         (c.show_price == null) ? true : bool(c.show_price),
    use_product_price:  bool(c.use_product_price),
    price_current:      str(c.price_current, '$24.990'),
    price_original:     str(c.price_original, '$31.990'),
    price_color:        hex(c.price_color, '#000000'),
    price_size:         num(c.price_size, 22),
    price_orig_color:   hex(c.price_orig_color, '#9CA3AF'),
    price_orig_size:    num(c.price_orig_size, 16),

    // CTA — usamos los mismos IDs que ctaCommonSchemaSettings para reusar los helpers Liquid
    action_type:        ['shopify_checkout','shopify_addtocart','releaseit','custom_url'].includes(c.action_type) ? c.action_type : 'releaseit',
    custom_url:         str(c.custom_url, ''),
    text:               str(c.text, 'Pagar Contra Reembolso'),
    bg_color:           hex(c.bg_color, '#000000'),
    text_color:         hex(c.text_color, '#FFFFFF'),
    font_family:        str(c.font_family, 'system-ui'),
    text_style:         ['uppercase','normal','lowercase'].includes(c.text_style) ? c.text_style : 'normal',
    bold:               (c.bold == null) ? true : bool(c.bold),
    font_size:          num(c.font_size, 16),
    letter_spacing:     num(c.letter_spacing, 0.5),
    btn_pad_y:          num(c.btn_pad_y, 16),
    border_radius:      Math.min(60, Math.max(0, num(c.border_radius, 8))),
    logo_top_url:       str(c.logo_top_url, ''),
    logo_bottom_url:    str(c.logo_bottom_url, ''),

    // Icono de carrito a la izquierda del texto del botón
    show_cart_icon:     (c.show_cart_icon == null) ? true : bool(c.show_cart_icon),

    // Sticky on scroll
    sticky_on_scroll:   (c.sticky_on_scroll == null) ? true : bool(c.sticky_on_scroll),
    sticky_bg:          hex(c.sticky_bg, '#FFFFFF'),
    sticky_shadow:      (c.sticky_shadow == null) ? true : bool(c.sticky_shadow),

    // Trust badges
    show_badges:        (c.show_badges == null) ? true : bool(c.show_badges),
    badge_1_icon:       icon(c.badge_1_icon, 'truck'),
    badge_1_label:      str(c.badge_1_label, 'Envío Gratis Express'),
    badge_2_icon:       icon(c.badge_2_icon, 'dollar'),
    badge_2_label:      str(c.badge_2_label, 'Pago al Recibir'),
    badge_3_icon:       icon(c.badge_3_icon, 'package'),
    badge_3_label:      str(c.badge_3_label, 'Entregas en 2 a 5 días'),
    badge_icon_color:   hex(c.badge_icon_color, '#111111'),
    badge_icon_size:    num(c.badge_icon_size, 28),
    badge_label_color:  hex(c.badge_label_color, '#444444'),
    badge_label_size:   num(c.badge_label_size, 12),

    // Testimonio
    show_testimonial:   (c.show_testimonial == null) ? true : bool(c.show_testimonial),
    t_name:             str(c.t_name, 'Luis Q.'),
    t_text:             str(c.t_text, ''),
    t_rating:           Math.min(5, Math.max(0, num(c.t_rating, 5))),
    t_avatar_url:       str(c.t_avatar_url, ''),
    t_card_bg:          hex(c.t_card_bg, '#FFFFFF'),
    t_card_border:      hex(c.t_card_border, '#E5E7EB'),
    t_card_radius:      Math.min(32, Math.max(0, num(c.t_card_radius, 12))),
    t_card_padding:     num(c.t_card_padding, 16),
    t_avatar_size:      num(c.t_avatar_size, 56),
    t_avatar_bg:        hex(c.t_avatar_bg, '#F59E0B'),
    t_avatar_color:     hex(c.t_avatar_color, '#FFFFFF'),
    t_name_color:       hex(c.t_name_color, '#111111'),
    t_name_size:        num(c.t_name_size, 14),
    t_text_color:       hex(c.t_text_color, '#444444'),
    t_text_size:        num(c.t_text_size, 13),
    t_star_color:       hex(c.t_star_color, '#F59E0B'),
    t_star_size:        num(c.t_star_size, 14),

    // Espacios verticales entre componentes (defaults = valores hardcodeados originales)
    gap_after_rating:   num(c.gap_after_rating, 10),
    gap_after_title:    num(c.gap_after_title, 10),
    gap_after_subtitle: num(c.gap_after_subtitle, 16),
    gap_benefit_items:  num(c.gap_benefit_items, 8),
    gap_after_benefits: num(c.gap_after_benefits, 18),
    gap_after_price:    num(c.gap_after_price, 16),
    gap_after_cta:      num(c.gap_after_cta, 16),
    gap_after_badges:   num(c.gap_after_badges, 16),

    // Sección
    section_bg:         hex(c.section_bg, '#FFFFFF'),
    max_width:          num(c.max_width, 1200),
    pad_top:            num(c.pad_top, 24),
    pad_bottom:         num(c.pad_bottom, 24),
    pad_x:              num(c.pad_x, 20),
  };
}

function purchasePopupBuildBlocks(config) {
  const items = Array.isArray(config?.items) ? config.items : [];
  const blocks = {};
  const block_order = [];
  let i = 0;
  for (const it of items) {
    if (!it || !it.name) continue;
    i++;
    const id = `p${i}`;
    blocks[id] = {
      type: 'purchase',
      settings: {
        name: String(it.name || '').trim(),
        city: String(it.city || '').trim(),
      },
    };
    block_order.push(id);
  }
  return { blocks, block_order };
}

function comparisonBuildBlocks(config) {
  const items = Array.isArray(config?.items) ? config.items : [];
  const blocks = {};
  const block_order = [];
  let i = 0;
  for (const it of items) {
    if (!it || !it.label) continue;
    i++;
    const id = `c${i}`;
    blocks[id] = {
      type: 'criterion',
      settings: {
        label:       String(it.label || '').trim(),
        ours_text:   String(it.ours_text   || '').trim(),
        theirs_text: String(it.theirs_text || '').trim(),
      },
    };
    block_order.push(id);
  }
  return { blocks, block_order };
}

function statsBuildBlocks(config) {
  const items = Array.isArray(config?.items) ? config.items : [];
  const blocks = {};
  const block_order = [];
  let i = 0;
  for (const it of items) {
    if (!it || (!it.number && !it.label)) continue;
    i++;
    const id = `s${i}`;
    blocks[id] = {
      type: 'stat',
      settings: {
        number: String(it.number || '').trim(),
        label:  String(it.label  || '').trim(),
        desc:   String(it.desc   || '').trim(),
      },
    };
    block_order.push(id);
  }
  return { blocks, block_order };
}

function featuresBuildBlocks(config) {
  const items = Array.isArray(config?.items) ? config.items : [];
  const blocks = {};
  const block_order = [];
  let i = 0;
  for (const it of items) {
    if (!it || (!it.title && !it.description)) continue;
    i++;
    const id = `f${i}`;
    blocks[id] = {
      type: 'feature',
      settings: {
        icon:        icon(it.icon, 'check'),
        title:       String(it.title       || '').trim(),
        description: String(it.description || '').trim(),
      },
    };
    block_order.push(id);
  }
  return { blocks, block_order };
}

function testimonialsBuildBlocks(config) {
  const items = Array.isArray(config?.items) ? config.items : [];
  const blocks = {};
  const block_order = [];
  let i = 0;
  for (const it of items) {
    if (!it || (!it.name && !it.text)) continue;
    i++;
    const id = `t${i}`;
    const rating = Math.min(5, Math.max(0, Number(it.rating) || 5));
    blocks[id] = {
      type: 'testimonial',
      settings: {
        name:     String(it.name     || '').trim(),
        location: String(it.location || '').trim(),
        rating:   rating,
        text:     String(it.text     || '').trim(),
      },
    };
    block_order.push(id);
  }
  return { blocks, block_order };
}

function trustBadgesBuildBlocks(config) {
  const items = Array.isArray(config?.items) ? config.items : [];
  const blocks = {};
  const block_order = [];
  let i = 0;
  for (const it of items) {
    if (!it || !it.label) continue;
    i++;
    const id = `b${i}`;
    blocks[id] = {
      type: 'badge',
      settings: {
        icon:  icon(it.icon, 'check'),
        label: String(it.label || '').trim(),
      },
    };
    block_order.push(id);
  }
  return { blocks, block_order };
}

// Convert the element's `config.questions = [{q, a}, ...]` to the Shopify
// blocks structure used in the JSON template: { blocks: {id→{type,settings}}, block_order: [...] }
function faqBuildBlocks(config) {
  const qs = Array.isArray(config?.questions) ? config.questions : [];
  const blocks = {};
  const block_order = [];
  let i = 0;
  for (const item of qs) {
    if (!item || (typeof item.q !== 'string' && typeof item.a !== 'string')) continue;
    i++;
    const blockId = `b${i}`;
    blocks[blockId] = {
      type: 'faq_item',
      settings: {
        q: String(item.q || '').trim(),
        a: String(item.a || '').trim(),
      },
    };
    block_order.push(blockId);
  }
  return { blocks, block_order };
}

// ─────────────────────────────────────────────────────────────────
// Section file Liquid builders — each returns the FULL .liquid file
// ─────────────────────────────────────────────────────────────────

function imageSectionLiquid() {
  const schema = {
    name: 'Imagen de Landing',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      { type: 'text',     id: 'image_url', label: 'URL de la imagen (HTTPS)', info: 'Pegá la URL del CDN. Si la cambiás, subí la imagen primero a Shopify → Contenido → Archivos.' },
      { type: 'text',     id: 'alt',       label: 'Texto alternativo' },
      { type: 'text',     id: 'link',      label: 'Enlace (opcional)', info: 'URL completa.' },
      { type: 'range',    id: 'max_width', label: 'Ancho máximo', min: 600, max: 1600, step: 20, unit: 'px', default: 1200 },
      { type: 'checkbox', id: 'eager_load', label: 'Carga inmediata (primera imagen del landing)', default: false },
    ],
    presets: [{ name: 'Imagen de Landing' }],
  };
  return `{%- comment -%} Ecom Studio AI — Imagen de Landing {%- endcomment -%}
{%- assign s = section.settings -%}
{%- if s.image_url != blank -%}
  {%- if s.link != blank -%}
    <a href="{{ s.link | escape }}" style="display:block;line-height:0;max-width:{{ s.max_width }}px;margin:0 auto">
      <img src="{{ s.image_url }}" alt="{{ s.alt | escape }}" loading="{% if s.eager_load %}eager{% else %}lazy{% endif %}" style="width:100%;height:auto;display:block">
    </a>
  {%- else -%}
    <div style="display:block;line-height:0;max-width:{{ s.max_width }}px;margin:0 auto">
      <img src="{{ s.image_url }}" alt="{{ s.alt | escape }}" loading="{% if s.eager_load %}eager{% else %}lazy{% endif %}" style="width:100%;height:auto;display:block">
    </div>
  {%- endif -%}
{%- endif -%}

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function announcementBarSectionLiquid() {
  const fontOptions = [
    { value: 'system-ui',  label: 'System UI' },
    { value: 'Inter',      label: 'Inter' },
    { value: 'Roboto',     label: 'Roboto' },
    { value: 'Poppins',    label: 'Poppins' },
    { value: 'Montserrat', label: 'Montserrat' },
    { value: 'Arial',      label: 'Arial' },
    { value: 'Georgia',    label: 'Georgia' },
  ];
  const weightOptions = ['300','400','500','600','700','800'].map(v => ({ value: v, label: v }));
  const schema = {
    name: 'Barra de Anuncios',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      { type: 'header', content: 'General' },
      { type: 'text', id: 'anchor_id', label: 'Anchor ID', info: 'Identificador único (sin espacios).', default: 'announcement-bar' },
      { type: 'checkbox', id: 'sticky', label: 'Fija al tope al hacer scroll', default: true },

      { type: 'header', content: 'Contenido' },
      { type: 'textarea', id: 'text', label: 'Texto de la barra', default: 'PAGO CONTRA ENTREGA + ENVÍO GRATIS' },
      { type: 'checkbox', id: 'uppercase', label: 'MAYÚSCULAS', default: false },

      { type: 'header', content: 'Fondo' },
      { type: 'color', id: 'bg_color', label: 'Color de fondo', default: '#000000' },
      { type: 'checkbox', id: 'use_gradient', label: 'Usar gradiente', default: false },
      { type: 'color', id: 'bg_gradient_to', label: 'Color final del gradiente', default: '#000000' },

      { type: 'header', content: 'Tipografía' },
      { type: 'color', id: 'text_color', label: 'Color del texto', default: '#FFFFFF' },
      { type: 'select', id: 'font_family', label: 'Tipografía', default: 'system-ui', options: fontOptions },
      { type: 'range', id: 'font_size', label: 'Tamaño', min: 10, max: 28, step: 1, unit: 'px', default: 14 },
      { type: 'select', id: 'font_weight', label: 'Peso de fuente', default: '500', options: weightOptions },
      { type: 'range', id: 'letter_spacing', label: 'Espaciado entre letras', min: 0, max: 3, step: 0.1, unit: 'px', default: 0.3 },

      { type: 'header', content: 'Espaciado' },
      { type: 'range', id: 'max_width', label: 'Ancho máximo (desktop)', min: 600, max: 1600, step: 20, unit: 'px', default: 1200 },
      { type: 'range', id: 'padding_v', label: 'Padding vertical', min: 0, max: 40, step: 1, unit: 'px', default: 15 },
      { type: 'range', id: 'padding_h', label: 'Padding horizontal', min: 0, max: 60, step: 1, unit: 'px', default: 20 },
    ],
    presets: [{ name: 'Barra de Anuncios' }],
  };
  return `{%- comment -%} Ecom Studio AI — Barra de Anuncios {%- endcomment -%}
{%- assign s = section.settings -%}
{%- if s.use_gradient and s.bg_gradient_to != blank -%}
  {%- assign bg = 'linear-gradient(90deg, ' | append: s.bg_color | append: ', ' | append: s.bg_gradient_to | append: ')' -%}
{%- else -%}
  {%- assign bg = s.bg_color -%}
{%- endif -%}
{%- assign txt = s.text -%}
{%- if s.uppercase -%}{%- assign txt = txt | upcase -%}{%- endif -%}
{%- case s.font_family -%}
  {%- when 'system-ui' -%}{%- assign ff = '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif' -%}
  {%- else -%}{%- assign ff = s.font_family -%}
{%- endcase -%}
<div {% if s.anchor_id != blank %}id="{{ s.anchor_id }}"{% endif %} class="ecom-studio-announcement-bar"
     style="background:{{ bg }};color:{{ s.text_color }};font-family:{{ ff }};font-size:{{ s.font_size }}px;font-weight:{{ s.font_weight }};letter-spacing:{{ s.letter_spacing }}px;padding:{{ s.padding_v }}px {{ s.padding_h }}px;text-align:center;line-height:1.35;{% if s.sticky %}position:sticky;top:0;z-index:50;{% endif %}">
  <div style="max-width:{{ s.max_width }}px;margin:0 auto;width:100%">{{ txt | escape }}</div>
</div>

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function connectorSectionLiquid() {
  const weightOptions = ['300','400','500','600','700','800'].map(v => ({ value: v, label: v }));
  const schema = {
    name: 'Conector',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      { type: 'select', id: 'variant', label: 'Tipo de conector', default: 'highlighted', options: [
        { value: 'highlighted', label: 'Texto destacado' },
        { value: 'gradient',    label: 'Degradado' },
      ]},

      { type: 'header', content: 'Layout' },
      { type: 'range', id: 'max_width',  label: 'Ancho máximo',    min: 200, max: 1600, step: 20, unit: 'px', default: 1200 },
      { type: 'range', id: 'pad_x',      label: 'Padding lateral', min: 0,   max: 80,   step: 1,  unit: 'px', default: 20 },
      { type: 'range', id: 'pad_top',    label: 'Padding superior',min: 0,   max: 80,   step: 1,  unit: 'px', default: 10 },
      { type: 'range', id: 'pad_bottom', label: 'Padding inferior',min: 0,   max: 80,   step: 1,  unit: 'px', default: 10 },

      { type: 'header', content: 'Variante: Texto destacado' },
      { type: 'textarea', id: 'text', label: 'Texto', default: 'ENVÍO GRATIS A TODO EL PAÍS' },
      { type: 'checkbox', id: 'uppercase', label: 'MAYÚSCULAS', default: true },
      { type: 'color', id: 'bg_color',   label: 'Fondo', default: '#000000' },
      { type: 'color', id: 'text_color', label: 'Texto', default: '#FFFFFF' },
      { type: 'range', id: 'font_size',  label: 'Tamaño', min: 8, max: 40, step: 1, unit: 'px', default: 14 },
      { type: 'select', id: 'font_weight', label: 'Peso', default: '700', options: weightOptions },
      { type: 'range', id: 'letter_spacing', label: 'Espaciado', min: 0, max: 5, step: 0.1, unit: 'px', default: 0.5 },

      { type: 'header', content: 'Variante: Degradado' },
      { type: 'color', id: 'grad_color_top',    label: 'Color superior', default: '#000000' },
      { type: 'color', id: 'grad_color_bottom', label: 'Color inferior', default: '#FFFFFF' },
      { type: 'range', id: 'grad_height',       label: 'Alto', min: 10, max: 300, step: 5, unit: 'px', default: 60 },
    ],
    presets: [{ name: 'Conector' }],
  };
  return `{%- comment -%} Ecom Studio AI — Conector {%- endcomment -%}
{%- assign s = section.settings -%}
{%- if s.variant == 'gradient' -%}
  <div class="ecom-studio-connector ecom-studio-connector-gradient" style="display:block;background:linear-gradient(180deg, {{ s.grad_color_top }}, {{ s.grad_color_bottom }});height:{{ s.grad_height }}px;line-height:0;font-size:0"></div>
{%- else -%}
  {%- assign txt = s.text -%}
  {%- if s.uppercase -%}{%- assign txt = txt | upcase -%}{%- endif -%}
  <div class="ecom-studio-connector ecom-studio-connector-highlighted" style="display:block;background:{{ s.bg_color }};color:{{ s.text_color }};font-size:{{ s.font_size }}px;font-weight:{{ s.font_weight }};letter-spacing:{{ s.letter_spacing }}px;padding:{{ s.pad_top }}px {{ s.pad_x }}px {{ s.pad_bottom }}px;line-height:1.35;text-align:center">
    <div style="max-width:{{ s.max_width }}px;margin:0 auto;width:100%">{{ txt | escape }}</div>
  </div>
{%- endif -%}

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function authoritySectionLiquid() {
  const schema = {
    name: 'Prueba de Autoridad',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      { type: 'header', content: 'Imagen' },
      { type: 'text', id: 'image_url', label: 'URL de la imagen (HTTPS)', info: 'Subila a Shopify → Contenido → Archivos y pegá la URL aquí.' },
      { type: 'text', id: 'alt', label: 'Texto alternativo' },

      { type: 'header', content: 'Layout' },
      { type: 'range', id: 'max_width',  label: 'Ancho máximo',    min: 200, max: 1600, step: 20, unit: 'px', default: 1200 },
      { type: 'range', id: 'img_width',  label: 'Ancho imagen',    min: 100, max: 1600, step: 20, unit: 'px', default: 720 },
      { type: 'range', id: 'pad_x',      label: 'Padding lateral', min: 0, max: 80, step: 1, unit: 'px', default: 20 },
      { type: 'range', id: 'pad_top',    label: 'Padding superior',min: 0, max: 80, step: 1, unit: 'px', default: 10 },
      { type: 'range', id: 'pad_bottom', label: 'Padding inferior',min: 0, max: 80, step: 1, unit: 'px', default: 10 },
      { type: 'color', id: 'bg_color',   label: 'Color de fondo', default: '#FFFFFF' },
    ],
    presets: [{ name: 'Prueba de Autoridad' }],
  };
  return `{%- comment -%} Ecom Studio AI — Prueba de Autoridad {%- endcomment -%}
{%- assign s = section.settings -%}
{%- if s.image_url != blank -%}
<div class="ecom-studio-authority" style="display:block;background:{{ s.bg_color }};padding:{{ s.pad_top }}px {{ s.pad_x }}px {{ s.pad_bottom }}px;line-height:0;font-size:0;text-align:center">
  <div style="max-width:{{ s.max_width }}px;margin:0 auto;width:100%">
    <img src="{{ s.image_url }}" alt="{{ s.alt | escape }}" loading="lazy" style="max-width:{{ s.img_width }}px;width:100%;height:auto;display:inline-block">
  </div>
</div>
{%- endif -%}

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function comparisonSectionLiquid() {
  const schema = {
    name: 'Tabla Comparativa',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      { type: 'header', content: 'Título y descripción' },
      { type: 'text', id: 'title', label: 'Título', default: 'Lo que nos hace diferentes' },
      { type: 'checkbox', id: 'show_title', label: 'Mostrar título', default: true },
      { type: 'color', id: 'title_color', label: 'Color del título', default: '#000000' },
      { type: 'range', id: 'title_size', label: 'Tamaño del título', min: 14, max: 48, step: 1, unit: 'px', default: 28 },
      { type: 'select', id: 'title_align', label: 'Alineación', default: 'left', options: [
        { value: 'left', label: 'Izquierda' },
        { value: 'center', label: 'Centrado' },
        { value: 'right', label: 'Derecha' },
      ]},
      { type: 'textarea', id: 'description', label: 'Descripción (opcional)' },
      { type: 'color', id: 'desc_color', label: 'Color de la descripción', default: '#444444' },
      { type: 'range', id: 'desc_size', label: 'Tamaño descripción', min: 11, max: 22, step: 1, unit: 'px', default: 15 },
      { type: 'range', id: 'title_table_gap', label: 'Espacio entre título y tabla', min: 0, max: 80, step: 2, unit: 'px', default: 24 },

      { type: 'header', content: 'Layout' },
      { type: 'select', id: 'layout', label: 'Disposición', default: 'stacked', options: [
        { value: 'stacked', label: 'Apilado (título arriba, tabla abajo)' },
        { value: 'side_by_side', label: 'Lado a lado (título izq, tabla der)' },
      ]},
      { type: 'color', id: 'bg_color', label: 'Color de fondo', default: '#FFFFFF' },
      { type: 'range', id: 'max_width', label: 'Ancho máximo', min: 400, max: 1600, step: 20, unit: 'px', default: 1200 },
      { type: 'range', id: 'pad_top', label: 'Padding superior', min: 0, max: 120, step: 4, unit: 'px', default: 40 },
      { type: 'range', id: 'pad_bottom', label: 'Padding inferior', min: 0, max: 120, step: 4, unit: 'px', default: 40 },
      { type: 'range', id: 'pad_x', label: 'Padding lateral', min: 0, max: 60, step: 2, unit: 'px', default: 20 },

      { type: 'header', content: 'Cabeceras de columnas' },
      { type: 'text', id: 'our_label', label: 'Etiqueta nuestra columna', default: 'Nuestro producto' },
      { type: 'text', id: 'their_label', label: 'Etiqueta de la competencia', default: 'Otros' },
      { type: 'color', id: 'header_color', label: 'Color del texto', default: '#999999' },
      { type: 'range', id: 'header_size', label: 'Tamaño', min: 11, max: 20, step: 1, unit: 'px', default: 13 },
      { type: 'checkbox', id: 'header_nowrap', label: 'Forzar headers en una sola línea', default: false, info: 'Útil si "Otros" o "Nuestro producto" se cortan.' },
      { type: 'range', id: 'criteria_col_width', label: 'Ancho columna de criterios (%)', min: 30, max: 70, step: 1, unit: '%', default: 50, info: 'Define cuánto del ancho total ocupa la columna naranja. Las otras dos se reparten el resto.' },

      { type: 'header', content: 'Estilo de la tabla' },
      { type: 'color', id: 'criteria_bg', label: 'Fondo de la columna de criterios', default: '#F59E0B' },
      { type: 'color', id: 'criteria_color', label: 'Color del texto de criterios', default: '#FFFFFF' },
      { type: 'color', id: 'cell_bg', label: 'Fondo de las celdas de check/cross', default: '#FFFFFF' },
      { type: 'color', id: 'row_border', label: 'Línea entre filas', default: '#F0F0F0' },
      { type: 'color', id: 'table_border', label: 'Borde exterior', default: '#E5E5E5' },
      { type: 'range', id: 'table_radius', label: 'Radio de la tabla', min: 0, max: 32, step: 1, unit: 'px', default: 12 },
      { type: 'range', id: 'cell_padding', label: 'Padding interno', min: 8, max: 32, step: 1, unit: 'px', default: 14 },
      { type: 'range', id: 'label_size', label: 'Tamaño del criterio', min: 11, max: 22, step: 1, unit: 'px', default: 14 },
      { type: 'select', id: 'label_weight', label: 'Peso del criterio', default: '700', options: [
        { value: '400', label: '400' }, { value: '500', label: '500' }, { value: '600', label: '600' }, { value: '700', label: '700' }, { value: '800', label: '800' },
      ]},

      { type: 'header', content: 'Iconos' },
      { type: 'color', id: 'check_color', label: 'Color del check (✓)', default: '#22C55E' },
      { type: 'color', id: 'cross_color', label: 'Color de la cruz (✗)', default: '#9CA3AF' },
      { type: 'range', id: 'icon_size', label: 'Tamaño del icono', min: 12, max: 40, step: 1, unit: 'px', default: 22 },
    ],
    blocks: [
      {
        type: 'criterion',
        name: 'Criterio',
        settings: [
          { type: 'text', id: 'label', label: 'Criterio' },
          { type: 'text', id: 'ours_text', label: 'Texto columna nuestra (opcional)', info: 'Si está vacío, muestra ✓.' },
          { type: 'text', id: 'theirs_text', label: 'Texto columna competencia (opcional)', info: 'Si está vacío, muestra ✗.' },
        ],
      },
    ],
    max_blocks: 12,
    presets: [{ name: 'Tabla Comparativa' }],
  };
  // Inline SVGs for ✓ / ✗ — color comes from CSS currentColor
  const checkSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
  const crossSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

  return `{%- comment -%} Ecom Studio AI — Tabla Comparativa {%- endcomment -%}
{%- assign s = section.settings -%}
{%- capture title_block -%}
  {%- if s.show_title and s.title != blank -%}
    <h2 style="color:{{ s.title_color }};font-size:{{ s.title_size }}px;text-align:{{ s.title_align }};margin:0 0 12px;font-weight:700;line-height:1.2">{{ s.title | escape }}</h2>
  {%- endif -%}
  {%- if s.description != blank -%}
    <p style="color:{{ s.desc_color }};font-size:{{ s.desc_size }}px;text-align:{{ s.title_align }};margin:0;line-height:1.55">{{ s.description | newline_to_br }}</p>
  {%- endif -%}
{%- endcapture -%}
{%- capture table_block -%}
  {%- assign others_col_width = 100 | minus: s.criteria_col_width | divided_by: 2 -%}
  {%- if s.header_nowrap -%}{%- assign header_nowrap_css = 'white-space:nowrap;' -%}{%- else -%}{%- assign header_nowrap_css = 'word-break:break-word;hyphens:auto;' -%}{%- endif -%}
  <table class="ecom-studio-comparison__table" style="width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;border:1px solid {{ s.table_border }};border-radius:{{ s.table_radius }}px;overflow:hidden;background:{{ s.cell_bg }}">
    <colgroup>
      <col style="width:{{ s.criteria_col_width }}%">
      <col style="width:{{ others_col_width }}%">
      <col style="width:{{ others_col_width }}%">
    </colgroup>
    <thead>
      <tr>
        <th style="background:{{ s.criteria_bg }};border-bottom:1px solid {{ s.row_border }}"></th>
        <th style="padding:{{ s.cell_padding }}px;text-align:center;color:{{ s.header_color }};font-size:{{ s.header_size }}px;font-weight:600;background:{{ s.cell_bg }};border-bottom:1px solid {{ s.row_border }};{{ header_nowrap_css }}">{{ s.our_label | escape }}</th>
        <th style="padding:{{ s.cell_padding }}px;text-align:center;color:{{ s.header_color }};font-size:{{ s.header_size }}px;font-weight:600;background:{{ s.cell_bg }};border-bottom:1px solid {{ s.row_border }};{{ header_nowrap_css }}">{{ s.their_label | escape }}</th>
      </tr>
    </thead>
    <tbody>
      {%- for block in section.blocks -%}
        {%- if block.settings.label != blank -%}
          <tr {{ block.shopify_attributes }}>
            <td style="background:{{ s.criteria_bg }};color:{{ s.criteria_color }};font-weight:{{ s.label_weight }};font-size:{{ s.label_size }}px;padding:{{ s.cell_padding }}px;text-align:center;{% unless forloop.last %}border-bottom:1px solid {{ s.row_border }};{% endunless %}">{{ block.settings.label | escape }}</td>
            <td style="background:{{ s.cell_bg }};padding:{{ s.cell_padding }}px;text-align:center;{% unless forloop.last %}border-bottom:1px solid {{ s.row_border }};{% endunless %}">
              {%- if block.settings.ours_text != blank -%}
                <span style="font-size:{{ s.label_size }}px;font-weight:600;color:#111">{{ block.settings.ours_text | escape }}</span>
              {%- else -%}
                <span style="display:inline-block;width:{{ s.icon_size }}px;height:{{ s.icon_size }}px;color:{{ s.check_color }}">${checkSvg}</span>
              {%- endif -%}
            </td>
            <td style="background:{{ s.cell_bg }};padding:{{ s.cell_padding }}px;text-align:center;{% unless forloop.last %}border-bottom:1px solid {{ s.row_border }};{% endunless %}">
              {%- if block.settings.theirs_text != blank -%}
                <span style="font-size:{{ s.label_size }}px;font-weight:500;color:#999">{{ block.settings.theirs_text | escape }}</span>
              {%- else -%}
                <span style="display:inline-block;width:{{ s.icon_size }}px;height:{{ s.icon_size }}px;color:{{ s.cross_color }}">${crossSvg}</span>
              {%- endif -%}
            </td>
          </tr>
        {%- endif -%}
      {%- endfor -%}
    </tbody>
  </table>
{%- endcapture -%}
<section class="ecom-studio-comparison" style="display:block;background:{{ s.bg_color }};padding:{{ s.pad_top }}px {{ s.pad_x }}px {{ s.pad_bottom }}px">
  <div style="max-width:{{ s.max_width }}px;margin:0 auto;width:100%">
    {%- if s.layout == 'side_by_side' -%}
      <div class="ecom-studio-comparison__wrap" style="display:grid;grid-template-columns:1fr 1.2fr;gap:{{ s.title_table_gap | plus: 16 }}px;align-items:center">
        <div>{{ title_block }}</div>
        <div>{{ table_block }}</div>
      </div>
    {%- else -%}
      <div style="margin-bottom:{{ s.title_table_gap }}px">{{ title_block }}</div>
      {{ table_block }}
    {%- endif -%}
  </div>
</section>
<style>
  @media (max-width: 720px) {
    .ecom-studio-comparison__wrap { grid-template-columns: 1fr !important; gap: 20px !important; }
  }
</style>

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function featuresSectionLiquid() {
  const iconOptions = ICON_KEYS.map(k => ({ value: k, label: k.charAt(0).toUpperCase() + k.slice(1) }));
  const schema = {
    name: 'Features con Iconos',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      { type: 'header', content: 'Título y descripción' },
      { type: 'text', id: 'title', label: 'Título', default: '¿Por qué elegirnos?' },
      { type: 'checkbox', id: 'show_title', label: 'Mostrar título', default: true },
      { type: 'color', id: 'title_color', label: 'Color del título', default: '#000000' },
      { type: 'range', id: 'title_size', label: 'Tamaño del título', min: 14, max: 48, step: 1, unit: 'px', default: 28 },
      { type: 'select', id: 'title_align', label: 'Alineación', default: 'center', options: [
        { value: 'left', label: 'Izquierda' },
        { value: 'center', label: 'Centrado' },
        { value: 'right', label: 'Derecha' },
      ]},
      { type: 'textarea', id: 'description', label: 'Descripción (opcional)' },
      { type: 'color', id: 'desc_color', label: 'Color descripción', default: '#444444' },
      { type: 'range', id: 'desc_size', label: 'Tamaño descripción', min: 11, max: 22, step: 1, unit: 'px', default: 15 },
      { type: 'range', id: 'title_grid_gap', label: 'Espacio entre título y grid', min: 0, max: 80, step: 2, unit: 'px', default: 32 },

      { type: 'header', content: 'Layout' },
      { type: 'color', id: 'bg_color', label: 'Color de fondo', default: '#FFFFFF' },
      { type: 'range', id: 'max_width', label: 'Ancho máximo', min: 400, max: 1600, step: 20, unit: 'px', default: 1200 },
      { type: 'range', id: 'pad_top', label: 'Padding superior', min: 0, max: 120, step: 4, unit: 'px', default: 40 },
      { type: 'range', id: 'pad_bottom', label: 'Padding inferior', min: 0, max: 120, step: 4, unit: 'px', default: 40 },
      { type: 'range', id: 'pad_x', label: 'Padding lateral', min: 0, max: 60, step: 2, unit: 'px', default: 20 },
      { type: 'range', id: 'columns', label: 'Columnas (desktop)', min: 1, max: 4, step: 1, default: 3 },
      { type: 'range', id: 'item_gap', label: 'Espacio entre features', min: 0, max: 60, step: 2, unit: 'px', default: 24 },
      { type: 'select', id: 'item_align', label: 'Alineación de cada feature', default: 'center', options: [
        { value: 'left', label: 'Izquierda' },
        { value: 'center', label: 'Centrado' },
        { value: 'right', label: 'Derecha' },
      ]},

      { type: 'header', content: 'Icono' },
      { type: 'select', id: 'icon_style', label: 'Estilo', default: 'circle', options: [
        { value: 'plain',  label: 'Sin fondo' },
        { value: 'circle', label: 'Círculo' },
        { value: 'square', label: 'Cuadrado redondeado' },
      ]},
      { type: 'color', id: 'icon_color', label: 'Color del icono', default: '#F59E0B' },
      { type: 'color', id: 'icon_bg', label: 'Color de fondo del badge', default: '#FEF3C7' },
      { type: 'range', id: 'icon_size', label: 'Tamaño del icono', min: 14, max: 64, step: 1, unit: 'px', default: 28 },
      { type: 'range', id: 'badge_size', label: 'Tamaño del badge', min: 32, max: 120, step: 2, unit: 'px', default: 56 },
      { type: 'range', id: 'badge_radius', label: 'Radio del badge (cuadrado)', min: 0, max: 60, step: 1, unit: 'px', default: 12, info: 'Solo aplica si el estilo es "Cuadrado redondeado". El círculo siempre es perfecto.' },

      { type: 'header', content: 'Texto del feature' },
      { type: 'color', id: 'ft_title_color', label: 'Color del título', default: '#111111' },
      { type: 'range', id: 'ft_title_size', label: 'Tamaño título', min: 12, max: 28, step: 1, unit: 'px', default: 17 },
      { type: 'select', id: 'ft_title_weight', label: 'Peso título', default: '700', options: [
        { value: '400', label: '400' }, { value: '500', label: '500' }, { value: '600', label: '600' }, { value: '700', label: '700' }, { value: '800', label: '800' },
      ]},
      { type: 'color', id: 'ft_desc_color', label: 'Color descripción', default: '#555555' },
      { type: 'range', id: 'ft_desc_size', label: 'Tamaño descripción', min: 10, max: 20, step: 1, unit: 'px', default: 14 },
    ],
    blocks: [
      {
        type: 'feature',
        name: 'Feature',
        settings: [
          { type: 'select', id: 'icon', label: 'Icono', default: 'check', options: iconOptions },
          { type: 'text', id: 'title', label: 'Título' },
          { type: 'textarea', id: 'description', label: 'Descripción' },
        ],
      },
    ],
    max_blocks: 12,
    presets: [{ name: 'Features con Iconos' }],
  };

  // Build {% case s.icon %} branches that render the inner SVG for each icon
  const iconCases = ICON_KEYS.map(k =>
    `        {%- when '${k}' -%}${ICON_SET[k]}`
  ).join('\n');

  return `{%- comment -%} Ecom Studio AI — Features con Iconos {%- endcomment -%}
{%- assign s = section.settings -%}
{%- capture title_block -%}
  {%- if s.show_title and s.title != blank -%}
    <h2 style="color:{{ s.title_color }};font-size:{{ s.title_size }}px;text-align:{{ s.title_align }};margin:0 0 12px;font-weight:700;line-height:1.2">{{ s.title | escape }}</h2>
  {%- endif -%}
  {%- if s.description != blank -%}
    <p style="color:{{ s.desc_color }};font-size:{{ s.desc_size }}px;text-align:{{ s.title_align }};margin:0;line-height:1.55">{{ s.description | newline_to_br }}</p>
  {%- endif -%}
{%- endcapture -%}
{%- assign show_title_block = false -%}
{%- if s.show_title and s.title != blank -%}{%- assign show_title_block = true -%}{%- endif -%}
{%- if s.description != blank -%}{%- assign show_title_block = true -%}{%- endif -%}
<section class="ecom-studio-features" style="display:block;background:{{ s.bg_color }};padding:{{ s.pad_top }}px {{ s.pad_x }}px {{ s.pad_bottom }}px">
  <div style="max-width:{{ s.max_width }}px;margin:0 auto;width:100%">
    {%- if show_title_block -%}
      <div style="margin-bottom:{{ s.title_grid_gap }}px">{{ title_block }}</div>
    {%- endif -%}
    <div class="ecom-studio-features__grid" style="display:grid;grid-template-columns:repeat({{ s.columns }}, minmax(0, 1fr));gap:{{ s.item_gap }}px">
      {%- for block in section.blocks -%}
        {%- if block.settings.title != blank or block.settings.description != blank -%}
          {%- capture icon_inner -%}
            {%- case block.settings.icon -%}
${iconCases}
              {%- else -%}${ICON_SET.check}
            {%- endcase -%}
          {%- endcapture -%}
          {%- assign badge_radius_css = s.badge_radius -%}
          {%- if s.icon_style == 'circle' -%}{%- assign badge_radius_css = 999 -%}{%- endif -%}
          {%- if s.icon_style == 'plain' -%}
            {%- assign badge_style_css = 'background:transparent;' -%}
          {%- else -%}
            {%- assign badge_style_css = 'background:' | append: s.icon_bg | append: ';' -%}
          {%- endif -%}
          <div class="ecom-studio-features__item" style="text-align:{{ s.item_align }}" {{ block.shopify_attributes }}>
            <div style="display:flex;justify-content:{% if s.item_align == 'left' %}flex-start{% elsif s.item_align == 'right' %}flex-end{% else %}center{% endif %};margin-bottom:14px">
              <div style="{{ badge_style_css }}width:{{ s.badge_size }}px;height:{{ s.badge_size }}px;border-radius:{{ badge_radius_css }}px;display:inline-flex;align-items:center;justify-content:center;color:{{ s.icon_color }}">
                <svg xmlns="http://www.w3.org/2000/svg" width="{{ s.icon_size }}" height="{{ s.icon_size }}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{{ icon_inner }}</svg>
              </div>
            </div>
            {%- if block.settings.title != blank -%}
              <h3 style="color:{{ s.ft_title_color }};font-size:{{ s.ft_title_size }}px;font-weight:{{ s.ft_title_weight }};margin:0 0 6px;line-height:1.3">{{ block.settings.title | escape }}</h3>
            {%- endif -%}
            {%- if block.settings.description != blank -%}
              <p style="color:{{ s.ft_desc_color }};font-size:{{ s.ft_desc_size }}px;margin:0;line-height:1.55">{{ block.settings.description | newline_to_br }}</p>
            {%- endif -%}
          </div>
        {%- endif -%}
      {%- endfor -%}
    </div>
  </div>
</section>
<style>
  @media (max-width: 720px) {
    .ecom-studio-features__grid { grid-template-columns: 1fr !important; }
  }
</style>

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function testimonialsSectionLiquid() {
  const schema = {
    name: 'Testimonios',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      { type: 'header', content: 'Título y descripción' },
      { type: 'text', id: 'title', label: 'Título', default: 'Lo que dicen nuestros clientes' },
      { type: 'checkbox', id: 'show_title', label: 'Mostrar título', default: true },
      { type: 'color', id: 'title_color', label: 'Color del título', default: '#000000' },
      { type: 'range', id: 'title_size', label: 'Tamaño del título', min: 14, max: 48, step: 1, unit: 'px', default: 28 },
      { type: 'select', id: 'title_align', label: 'Alineación', default: 'center', options: [
        { value: 'left', label: 'Izquierda' },
        { value: 'center', label: 'Centrado' },
        { value: 'right', label: 'Derecha' },
      ]},
      { type: 'textarea', id: 'description', label: 'Descripción (opcional)' },
      { type: 'color', id: 'desc_color', label: 'Color descripción', default: '#444444' },
      { type: 'range', id: 'desc_size', label: 'Tamaño descripción', min: 11, max: 22, step: 1, unit: 'px', default: 15 },
      { type: 'range', id: 'title_grid_gap', label: 'Espacio entre título y grid', min: 0, max: 80, step: 2, unit: 'px', default: 32 },

      { type: 'header', content: 'Layout' },
      { type: 'color', id: 'bg_color', label: 'Color de fondo', default: '#FFFFFF' },
      { type: 'range', id: 'max_width', label: 'Ancho máximo', min: 400, max: 1600, step: 20, unit: 'px', default: 1200 },
      { type: 'range', id: 'pad_top', label: 'Padding superior', min: 0, max: 120, step: 4, unit: 'px', default: 40 },
      { type: 'range', id: 'pad_bottom', label: 'Padding inferior', min: 0, max: 120, step: 4, unit: 'px', default: 40 },
      { type: 'range', id: 'pad_x', label: 'Padding lateral', min: 0, max: 60, step: 2, unit: 'px', default: 20 },
      { type: 'range', id: 'columns', label: 'Columnas (desktop)', min: 1, max: 4, step: 1, default: 3 },
      { type: 'range', id: 'item_gap', label: 'Espacio entre tarjetas', min: 0, max: 48, step: 2, unit: 'px', default: 20 },

      { type: 'header', content: 'Tarjeta' },
      { type: 'color', id: 'card_bg', label: 'Fondo de la tarjeta', default: '#FAFAFA' },
      { type: 'color', id: 'card_border', label: 'Borde de la tarjeta', default: '#EEEEEE' },
      { type: 'range', id: 'card_radius', label: 'Radio', min: 0, max: 32, step: 1, unit: 'px', default: 14 },
      { type: 'range', id: 'card_padding', label: 'Padding interno', min: 12, max: 40, step: 1, unit: 'px', default: 22 },

      { type: 'header', content: 'Avatar (iniciales)' },
      { type: 'checkbox', id: 'show_avatar', label: 'Mostrar avatar', default: true },
      { type: 'range', id: 'avatar_size', label: 'Tamaño', min: 28, max: 80, step: 2, unit: 'px', default: 44 },
      { type: 'color', id: 'avatar_bg', label: 'Color de fondo', default: '#F59E0B' },
      { type: 'color', id: 'avatar_color', label: 'Color del texto', default: '#FFFFFF' },

      { type: 'header', content: 'Estrellas' },
      { type: 'checkbox', id: 'show_stars', label: 'Mostrar estrellas', default: true },
      { type: 'color', id: 'star_color', label: 'Color', default: '#F59E0B' },
      { type: 'range', id: 'star_size', label: 'Tamaño', min: 10, max: 32, step: 1, unit: 'px', default: 16 },

      { type: 'header', content: 'Nombre y ubicación' },
      { type: 'color', id: 'name_color', label: 'Color del nombre', default: '#111111' },
      { type: 'range', id: 'name_size', label: 'Tamaño del nombre', min: 11, max: 22, step: 1, unit: 'px', default: 15 },
      { type: 'color', id: 'loc_color', label: 'Color de la ubicación', default: '#888888' },
      { type: 'range', id: 'loc_size', label: 'Tamaño de la ubicación', min: 9, max: 18, step: 1, unit: 'px', default: 12 },

      { type: 'header', content: 'Texto del testimonio' },
      { type: 'color', id: 'text_color', label: 'Color', default: '#444444' },
      { type: 'range', id: 'text_size', label: 'Tamaño', min: 11, max: 22, step: 1, unit: 'px', default: 14 },
      { type: 'checkbox', id: 'text_italic', label: 'Itálica', default: false },
    ],
    blocks: [
      {
        type: 'testimonial',
        name: 'Testimonio',
        settings: [
          { type: 'text', id: 'name', label: 'Nombre' },
          { type: 'text', id: 'location', label: 'Ubicación (opcional)', info: 'Ej. "Bogotá, Colombia"' },
          { type: 'range', id: 'rating', label: 'Estrellas', min: 0, max: 5, step: 1, default: 5 },
          { type: 'textarea', id: 'text', label: 'Texto del testimonio' },
        ],
      },
    ],
    max_blocks: 12,
    presets: [{ name: 'Testimonios' }],
  };

  const starFilled = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15 8.5 22 9.3 17 14 18 21 12 17.8 6 21 7 14 2 9.3 9 8.5 12 2"/></svg>';
  const starEmpty  = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.35"><polygon points="12 2 15 8.5 22 9.3 17 14 18 21 12 17.8 6 21 7 14 2 9.3 9 8.5 12 2"/></svg>';

  return `{%- comment -%} Ecom Studio AI — Testimonios {%- endcomment -%}
{%- assign s = section.settings -%}
{%- capture title_block -%}
  {%- if s.show_title and s.title != blank -%}
    <h2 style="color:{{ s.title_color }};font-size:{{ s.title_size }}px;text-align:{{ s.title_align }};margin:0 0 12px;font-weight:700;line-height:1.2">{{ s.title | escape }}</h2>
  {%- endif -%}
  {%- if s.description != blank -%}
    <p style="color:{{ s.desc_color }};font-size:{{ s.desc_size }}px;text-align:{{ s.title_align }};margin:0;line-height:1.55">{{ s.description | newline_to_br }}</p>
  {%- endif -%}
{%- endcapture -%}
{%- assign show_title_block = false -%}
{%- if s.show_title and s.title != blank -%}{%- assign show_title_block = true -%}{%- endif -%}
{%- if s.description != blank -%}{%- assign show_title_block = true -%}{%- endif -%}
<section class="ecom-studio-testimonials" style="display:block;background:{{ s.bg_color }};padding:{{ s.pad_top }}px {{ s.pad_x }}px {{ s.pad_bottom }}px">
  <div style="max-width:{{ s.max_width }}px;margin:0 auto;width:100%">
    {%- if show_title_block -%}
      <div style="margin-bottom:{{ s.title_grid_gap }}px">{{ title_block }}</div>
    {%- endif -%}
    <div class="ecom-studio-testimonials__grid" style="display:grid;grid-template-columns:repeat({{ s.columns }}, minmax(0, 1fr));gap:{{ s.item_gap }}px">
      {%- for block in section.blocks -%}
        {%- if block.settings.text != blank or block.settings.name != blank -%}
          {%- assign name_parts = block.settings.name | strip | split: ' ' -%}
          {%- assign first_letter = name_parts[0] | slice: 0, 1 | upcase -%}
          {%- assign last_letter = name_parts.last | slice: 0, 1 | upcase -%}
          {%- if name_parts.size > 1 -%}
            {%- assign initials = first_letter | append: last_letter -%}
          {%- else -%}
            {%- assign initials = first_letter -%}
          {%- endif -%}
          <article style="background:{{ s.card_bg }};border:1px solid {{ s.card_border }};border-radius:{{ s.card_radius }}px;padding:{{ s.card_padding }}px;display:flex;flex-direction:column;gap:12px" {{ block.shopify_attributes }}>
            {%- if s.show_stars and block.settings.rating > 0 -%}
              <div style="display:flex;gap:2px;color:{{ s.star_color }}">
                {%- for i in (1..5) -%}
                  <span style="display:inline-block;width:{{ s.star_size }}px;height:{{ s.star_size }}px;line-height:0">
                    {%- if i <= block.settings.rating -%}${starFilled}{%- else -%}${starEmpty}{%- endif -%}
                  </span>
                {%- endfor -%}
              </div>
            {%- endif -%}
            {%- if block.settings.text != blank -%}
              <p style="color:{{ s.text_color }};font-size:{{ s.text_size }}px;line-height:1.6;margin:0;{% if s.text_italic %}font-style:italic;{% endif %}">{{ block.settings.text | newline_to_br }}</p>
            {%- endif -%}
            {%- if block.settings.name != blank -%}
              <div style="display:flex;align-items:center;gap:10px;margin-top:auto">
                {%- if s.show_avatar -%}
                  <div style="flex-shrink:0;width:{{ s.avatar_size }}px;height:{{ s.avatar_size }}px;border-radius:999px;background:{{ s.avatar_bg }};color:{{ s.avatar_color }};display:inline-flex;align-items:center;justify-content:center;font-size:{{ s.avatar_size | times: 0.4 | round }}px;font-weight:700;line-height:1">{{ initials }}</div>
                {%- endif -%}
                <div style="display:flex;flex-direction:column;line-height:1.2;min-width:0">
                  <span style="color:{{ s.name_color }};font-size:{{ s.name_size }}px;font-weight:600">{{ block.settings.name | escape }}</span>
                  {%- if block.settings.location != blank -%}
                    <span style="color:{{ s.loc_color }};font-size:{{ s.loc_size }}px;margin-top:2px">{{ block.settings.location | escape }}</span>
                  {%- endif -%}
                </div>
              </div>
            {%- endif -%}
          </article>
        {%- endif -%}
      {%- endfor -%}
    </div>
  </div>
</section>
<style>
  @media (max-width: 720px) {
    .ecom-studio-testimonials__grid { grid-template-columns: 1fr !important; }
  }
</style>

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function countdownSectionLiquid() {
  const schema = {
    name: 'Countdown Timer',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      { type: 'header', content: 'Texto' },
      { type: 'text', id: 'title', label: 'Título', default: '¡Oferta por tiempo limitado!' },
      { type: 'checkbox', id: 'show_title', label: 'Mostrar título', default: true },
      { type: 'color', id: 'title_color', label: 'Color del título', default: '#000000' },
      { type: 'range', id: 'title_size', label: 'Tamaño del título', min: 12, max: 36, step: 1, unit: 'px', default: 20 },
      { type: 'select', id: 'title_align', label: 'Alineación', default: 'center', options: [
        { value: 'left', label: 'Izquierda' },
        { value: 'center', label: 'Centrado' },
        { value: 'right', label: 'Derecha' },
      ]},

      { type: 'header', content: 'Modo del contador' },
      { type: 'select', id: 'mode', label: 'Modo', default: 'evergreen', options: [
        { value: 'fixed',     label: 'Fecha fija (todos ven el mismo final)' },
        { value: 'evergreen', label: 'Evergreen (X horas desde la primera visita)' },
      ]},
      { type: 'text', id: 'target_date', label: 'Fecha objetivo (solo modo "Fecha fija")', info: 'Formato: 2025-12-31 23:59 (zona horaria del visitante).' },
      { type: 'range', id: 'duration_hours', label: 'Duración en horas (solo modo "Evergreen")', min: 1, max: 100, step: 1, default: 24, info: 'Para duraciones mayores a 4 días usá modo "Fecha fija".' },

      { type: 'header', content: 'Unidades visibles' },
      { type: 'checkbox', id: 'show_days', label: 'Mostrar días', default: true },
      { type: 'checkbox', id: 'show_hours', label: 'Mostrar horas', default: true },
      { type: 'checkbox', id: 'show_minutes', label: 'Mostrar minutos', default: true },
      { type: 'checkbox', id: 'show_seconds', label: 'Mostrar segundos', default: true },
      { type: 'checkbox', id: 'show_unit_labels', label: 'Mostrar etiquetas (Días, Horas...)', default: true },
      { type: 'text', id: 'label_days', label: 'Etiqueta días', default: 'Días' },
      { type: 'text', id: 'label_hours', label: 'Etiqueta horas', default: 'Horas' },
      { type: 'text', id: 'label_minutes', label: 'Etiqueta minutos', default: 'Minutos' },
      { type: 'text', id: 'label_seconds', label: 'Etiqueta segundos', default: 'Segundos' },

      { type: 'header', content: 'Estilo de los dígitos' },
      { type: 'select', id: 'box_style', label: 'Estilo', default: 'filled', options: [
        { value: 'filled',  label: 'Caja sólida' },
        { value: 'outline', label: 'Caja con borde' },
        { value: 'minimal', label: 'Solo números' },
      ]},
      { type: 'color', id: 'box_bg', label: 'Fondo de la caja', default: '#000000' },
      { type: 'color', id: 'box_color', label: 'Color del número', default: '#FFFFFF' },
      { type: 'color', id: 'box_border', label: 'Color del borde', default: '#000000' },
      { type: 'range', id: 'box_size', label: 'Tamaño del número', min: 18, max: 64, step: 1, unit: 'px', default: 36 },
      { type: 'range', id: 'box_width', label: 'Ancho de la caja', min: 40, max: 120, step: 2, unit: 'px', default: 70 },
      { type: 'range', id: 'box_height', label: 'Alto de la caja', min: 40, max: 140, step: 2, unit: 'px', default: 80 },
      { type: 'range', id: 'box_radius', label: 'Radio', min: 0, max: 24, step: 1, unit: 'px', default: 8 },
      { type: 'range', id: 'box_gap', label: 'Espacio entre cajas', min: 2, max: 32, step: 1, unit: 'px', default: 8 },
      { type: 'color', id: 'unit_label_color', label: 'Color de la etiqueta', default: '#666666' },
      { type: 'range', id: 'unit_label_size', label: 'Tamaño etiqueta', min: 9, max: 18, step: 1, unit: 'px', default: 11 },

      { type: 'header', content: 'Mensaje expirado' },
      { type: 'text', id: 'expired_text', label: 'Texto cuando el contador termina', default: '¡La oferta ha terminado!' },
      { type: 'color', id: 'expired_color', label: 'Color del texto expirado', default: '#EF4444' },

      { type: 'header', content: 'Layout' },
      { type: 'color', id: 'bg_color', label: 'Color de fondo', default: '#FFFFFF' },
      { type: 'range', id: 'max_width', label: 'Ancho máximo', min: 400, max: 1600, step: 20, unit: 'px', default: 1200 },
      { type: 'range', id: 'pad_top', label: 'Padding superior', min: 0, max: 80, step: 2, unit: 'px', default: 20 },
      { type: 'range', id: 'pad_bottom', label: 'Padding inferior', min: 0, max: 80, step: 2, unit: 'px', default: 20 },
      { type: 'range', id: 'pad_x', label: 'Padding lateral', min: 0, max: 60, step: 2, unit: 'px', default: 20 },
    ],
    presets: [{ name: 'Countdown Timer' }],
  };

  return `{%- comment -%} Ecom Studio AI — Countdown Timer {%- endcomment -%}
{%- assign s = section.settings -%}
{%- assign box_style_css = '' -%}
{%- if s.box_style == 'filled' -%}
  {%- assign box_style_css = 'background:' | append: s.box_bg | append: ';color:' | append: s.box_color | append: ';' -%}
{%- elsif s.box_style == 'outline' -%}
  {%- assign box_style_css = 'background:transparent;color:' | append: s.box_color | append: ';border:2px solid ' | append: s.box_border | append: ';' -%}
{%- else -%}
  {%- assign box_style_css = 'background:transparent;color:' | append: s.box_color | append: ';' -%}
{%- endif -%}
<section class="ecom-studio-countdown" style="display:block;background:{{ s.bg_color }};padding:{{ s.pad_top }}px {{ s.pad_x }}px {{ s.pad_bottom }}px">
  <div id="ecom-studio-countdown-{{ section.id }}" style="max-width:{{ s.max_width }}px;margin:0 auto;width:100%;text-align:{{ s.title_align }}"
       data-mode="{{ s.mode }}"
       data-target-date="{{ s.target_date | escape }}"
       data-duration-hours="{{ s.duration_hours }}">
    {%- if s.show_title and s.title != blank -%}
      <h3 style="color:{{ s.title_color }};font-size:{{ s.title_size }}px;margin:0 0 14px;font-weight:700;line-height:1.2">{{ s.title | escape }}</h3>
    {%- endif -%}
    <div data-countdown-live style="display:inline-flex;gap:{{ s.box_gap }}px;align-items:flex-start;flex-wrap:wrap;justify-content:{% if s.title_align == 'left' %}flex-start{% elsif s.title_align == 'right' %}flex-end{% else %}center{% endif %}">
      {%- if s.show_days -%}
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
          <div data-unit="days" style="{{ box_style_css }}width:{{ s.box_width }}px;height:{{ s.box_height }}px;border-radius:{{ s.box_radius }}px;display:flex;align-items:center;justify-content:center;font-size:{{ s.box_size }}px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1">00</div>
          {%- if s.show_unit_labels -%}<span style="color:{{ s.unit_label_color }};font-size:{{ s.unit_label_size }}px;letter-spacing:.04em;text-transform:uppercase">{{ s.label_days | escape }}</span>{%- endif -%}
        </div>
      {%- endif -%}
      {%- if s.show_hours -%}
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
          <div data-unit="hours" style="{{ box_style_css }}width:{{ s.box_width }}px;height:{{ s.box_height }}px;border-radius:{{ s.box_radius }}px;display:flex;align-items:center;justify-content:center;font-size:{{ s.box_size }}px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1">00</div>
          {%- if s.show_unit_labels -%}<span style="color:{{ s.unit_label_color }};font-size:{{ s.unit_label_size }}px;letter-spacing:.04em;text-transform:uppercase">{{ s.label_hours | escape }}</span>{%- endif -%}
        </div>
      {%- endif -%}
      {%- if s.show_minutes -%}
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
          <div data-unit="minutes" style="{{ box_style_css }}width:{{ s.box_width }}px;height:{{ s.box_height }}px;border-radius:{{ s.box_radius }}px;display:flex;align-items:center;justify-content:center;font-size:{{ s.box_size }}px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1">00</div>
          {%- if s.show_unit_labels -%}<span style="color:{{ s.unit_label_color }};font-size:{{ s.unit_label_size }}px;letter-spacing:.04em;text-transform:uppercase">{{ s.label_minutes | escape }}</span>{%- endif -%}
        </div>
      {%- endif -%}
      {%- if s.show_seconds -%}
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
          <div data-unit="seconds" style="{{ box_style_css }}width:{{ s.box_width }}px;height:{{ s.box_height }}px;border-radius:{{ s.box_radius }}px;display:flex;align-items:center;justify-content:center;font-size:{{ s.box_size }}px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1">00</div>
          {%- if s.show_unit_labels -%}<span style="color:{{ s.unit_label_color }};font-size:{{ s.unit_label_size }}px;letter-spacing:.04em;text-transform:uppercase">{{ s.label_seconds | escape }}</span>{%- endif -%}
        </div>
      {%- endif -%}
    </div>
    <div data-countdown-expired style="display:none;color:{{ s.expired_color }};font-size:{{ s.box_size | divided_by: 2 }}px;font-weight:700;line-height:1.3">{{ s.expired_text | escape }}</div>
  </div>
</section>
<script>
(function(){
  var root = document.getElementById('ecom-studio-countdown-{{ section.id }}');
  if (!root || root.__ecomStudioCountdownBound) return;
  root.__ecomStudioCountdownBound = true;
  var mode = root.getAttribute('data-mode');
  var target;
  if (mode === 'fixed') {
    var raw = (root.getAttribute('data-target-date') || '').trim();
    if (!raw) return;
    target = new Date(raw.replace(' ', 'T')).getTime();
    if (isNaN(target)) return;
  } else {
    var hours = Number(root.getAttribute('data-duration-hours')) || 24;
    var storageKey = 'ecom_studio_countdown_{{ section.id }}';
    var first = null;
    try { first = localStorage.getItem(storageKey); } catch(e){}
    if (!first) {
      first = String(Date.now());
      try { localStorage.setItem(storageKey, first); } catch(e){}
    }
    target = Number(first) + hours * 3600000;
  }
  var dEl = root.querySelector('[data-unit="days"]');
  var hEl = root.querySelector('[data-unit="hours"]');
  var mEl = root.querySelector('[data-unit="minutes"]');
  var sEl = root.querySelector('[data-unit="seconds"]');
  var liveEl = root.querySelector('[data-countdown-live]');
  var expEl  = root.querySelector('[data-countdown-expired]');
  var pad = function(n){ n = String(n); return n.length < 2 ? '0' + n : n; };
  var intervalId = null;
  function tick(){
    var diff = target - Date.now();
    if (diff <= 0) {
      if (liveEl) liveEl.style.display = 'none';
      if (expEl)  expEl.style.display  = 'block';
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
      return;
    }
    var remaining = diff;
    if (dEl) { var d = Math.floor(remaining / 86400000); dEl.textContent = pad(d); remaining -= d * 86400000; }
    if (hEl) { var h = Math.floor(remaining / 3600000);  hEl.textContent = pad(h); remaining -= h * 3600000; }
    if (mEl) { var m = Math.floor(remaining / 60000);    mEl.textContent = pad(m); remaining -= m * 60000; }
    if (sEl) { var ss = Math.floor(remaining / 1000);    sEl.textContent = pad(ss); }
  }
  tick();
  intervalId = setInterval(tick, 1000);
})();
</script>

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function stockBarSectionLiquid() {
  const schema = {
    name: 'Stock Limitado',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      { type: 'header', content: 'Encabezado' },
      { type: 'text', id: 'title', label: 'Título', default: '¡Stock limitado!' },
      { type: 'checkbox', id: 'show_title', label: 'Mostrar título', default: true },
      { type: 'color', id: 'title_color', label: 'Color del título', default: '#000000' },
      { type: 'range', id: 'title_size', label: 'Tamaño del título', min: 12, max: 32, step: 1, unit: 'px', default: 18 },
      { type: 'select', id: 'title_align', label: 'Alineación', default: 'left', options: [
        { value: 'left', label: 'Izquierda' },
        { value: 'center', label: 'Centrado' },
        { value: 'right', label: 'Derecha' },
      ]},
      { type: 'checkbox', id: 'show_alert_icon', label: 'Mostrar icono de alerta (⚠)', default: true },
      { type: 'color', id: 'alert_icon_color', label: 'Color del icono', default: '#EF4444' },

      { type: 'header', content: 'Mensaje' },
      { type: 'text', id: 'message', label: 'Mensaje', default: 'Solo quedan {count} unidades disponibles', info: 'Usá {count} para insertar el número de unidades.' },
      { type: 'color', id: 'message_color', label: 'Color del mensaje', default: '#444444' },
      { type: 'range', id: 'message_size', label: 'Tamaño del mensaje', min: 11, max: 22, step: 1, unit: 'px', default: 14 },
      { type: 'range', id: 'stock_count', label: 'Unidades restantes', min: 0, max: 100, step: 1, default: 7 },

      { type: 'header', content: 'Barra de progreso' },
      { type: 'range', id: 'bar_percent', label: 'Porcentaje visual de la barra', min: 0, max: 100, step: 1, unit: '%', default: 18, info: 'Independiente del número de unidades — controlá cuánto se "ve" lleno.' },
      { type: 'range', id: 'bar_height', label: 'Alto de la barra', min: 4, max: 40, step: 1, unit: 'px', default: 10 },
      { type: 'range', id: 'bar_radius', label: 'Radio', min: 0, max: 40, step: 1, unit: 'px', default: 20, info: 'Para "pill" (totalmente redondeado) usá un valor mayor o igual a la mitad del alto.' },
      { type: 'color', id: 'bar_bg', label: 'Fondo de la barra', default: '#F0F0F0' },
      { type: 'color', id: 'bar_fill', label: 'Color de relleno', default: '#EF4444' },
      { type: 'checkbox', id: 'use_gradient', label: 'Usar gradiente en el relleno', default: false },
      { type: 'color', id: 'bar_fill_to', label: 'Color final del gradiente', default: '#F59E0B' },
      { type: 'checkbox', id: 'animate_on_load', label: 'Animar al cargar', default: true },
      { type: 'checkbox', id: 'pulse', label: 'Pulsar (efecto urgente)', default: false },

      { type: 'header', content: 'Layout' },
      { type: 'color', id: 'bg_color', label: 'Color de fondo', default: '#FFFFFF' },
      { type: 'range', id: 'max_width', label: 'Ancho máximo', min: 300, max: 1600, step: 20, unit: 'px', default: 1200 },
      { type: 'range', id: 'pad_top', label: 'Padding superior', min: 0, max: 80, step: 2, unit: 'px', default: 16 },
      { type: 'range', id: 'pad_bottom', label: 'Padding inferior', min: 0, max: 80, step: 2, unit: 'px', default: 16 },
      { type: 'range', id: 'pad_x', label: 'Padding lateral', min: 0, max: 60, step: 2, unit: 'px', default: 20 },
    ],
    presets: [{ name: 'Stock Limitado' }],
  };

  const alertSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

  return `{%- comment -%} Ecom Studio AI — Stock Limitado {%- endcomment -%}
{%- assign s = section.settings -%}
{%- assign msg = s.message | replace: '{count}', s.stock_count -%}
{%- if s.use_gradient -%}
  {%- assign fill_bg = 'linear-gradient(90deg, ' | append: s.bar_fill | append: ', ' | append: s.bar_fill_to | append: ')' -%}
{%- else -%}
  {%- assign fill_bg = s.bar_fill -%}
{%- endif -%}
<section class="ecom-studio-stock-bar" style="display:block;background:{{ s.bg_color }};padding:{{ s.pad_top }}px {{ s.pad_x }}px {{ s.pad_bottom }}px">
  <div id="ecom-studio-stock-bar-{{ section.id }}" style="max-width:{{ s.max_width }}px;margin:0 auto;width:100%">
    {%- if s.show_title and s.title != blank -%}
      <div style="display:flex;align-items:center;gap:8px;justify-content:{% if s.title_align == 'left' %}flex-start{% elsif s.title_align == 'right' %}flex-end{% else %}center{% endif %};margin-bottom:6px">
        {%- if s.show_alert_icon -%}
          <span style="display:inline-block;width:{{ s.title_size }}px;height:{{ s.title_size }}px;color:{{ s.alert_icon_color }};flex-shrink:0">${alertSvg}</span>
        {%- endif -%}
        <h3 style="color:{{ s.title_color }};font-size:{{ s.title_size }}px;margin:0;font-weight:700;line-height:1.2">{{ s.title | escape }}</h3>
      </div>
    {%- endif -%}
    {%- if msg != blank -%}
      <p style="color:{{ s.message_color }};font-size:{{ s.message_size }}px;margin:0 0 10px;text-align:{{ s.title_align }};line-height:1.4">{{ msg }}</p>
    {%- endif -%}
    <div style="background:{{ s.bar_bg }};border-radius:{{ s.bar_radius }}px;overflow:hidden;height:{{ s.bar_height }}px;width:100%">
      <div class="ecom-studio-stock-bar__fill{% if s.pulse %} ecom-studio-stock-bar__pulse{% endif %}" style="background:{{ fill_bg }};height:100%;border-radius:{{ s.bar_radius }}px;width:{% if s.animate_on_load %}0%{% else %}{{ s.bar_percent }}%{% endif %};transition:width 1.2s cubic-bezier(.2,.7,.2,1)" data-target-percent="{{ s.bar_percent }}"></div>
    </div>
  </div>
</section>
<style>
  @keyframes ecom-studio-stock-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.55; }
  }
  .ecom-studio-stock-bar__pulse { animation: ecom-studio-stock-pulse 1.4s ease-in-out infinite; }
</style>
<script>
(function(){
  var root = document.getElementById('ecom-studio-stock-bar-{{ section.id }}');
  if (!root || root.__ecomStudioStockBound) return;
  root.__ecomStudioStockBound = true;
  var fill = root.querySelector('.ecom-studio-stock-bar__fill');
  if (!fill) return;
  var pct = Number(fill.getAttribute('data-target-percent')) || 0;
  // Trigger reflow then animate
  setTimeout(function(){ fill.style.width = pct + '%'; }, 60);
})();
</script>

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function trustBadgesSectionLiquid() {
  const iconOptions = ICON_KEYS.map(k => ({ value: k, label: k.charAt(0).toUpperCase() + k.slice(1) }));
  const schema = {
    name: 'Trust Badges',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      { type: 'header', content: 'Título (opcional)' },
      { type: 'text', id: 'title', label: 'Título' },
      { type: 'checkbox', id: 'show_title', label: 'Mostrar título', default: false },
      { type: 'color', id: 'title_color', label: 'Color del título', default: '#000000' },
      { type: 'range', id: 'title_size', label: 'Tamaño del título', min: 12, max: 32, step: 1, unit: 'px', default: 20 },
      { type: 'select', id: 'title_align', label: 'Alineación', default: 'center', options: [
        { value: 'left', label: 'Izquierda' },
        { value: 'center', label: 'Centrado' },
        { value: 'right', label: 'Derecha' },
      ]},
      { type: 'range', id: 'title_grid_gap', label: 'Espacio entre título y badges', min: 0, max: 60, step: 2, unit: 'px', default: 20 },

      { type: 'header', content: 'Layout' },
      { type: 'select', id: 'layout', label: 'Disposición', default: 'horizontal', options: [
        { value: 'horizontal', label: 'Fila única (responsive)' },
        { value: 'grid',       label: 'Grid en columnas' },
      ]},
      { type: 'range', id: 'columns', label: 'Columnas (solo Grid)', min: 2, max: 6, step: 1, default: 4 },
      { type: 'range', id: 'item_gap', label: 'Espacio entre badges', min: 0, max: 48, step: 2, unit: 'px', default: 20 },
      { type: 'select', id: 'item_direction', label: 'Dirección de cada badge', default: 'vertical', options: [
        { value: 'vertical',   label: 'Icono arriba + texto abajo' },
        { value: 'horizontal', label: 'Icono a la izquierda + texto a la derecha' },
      ]},
      { type: 'select', id: 'item_align', label: 'Alineación de cada badge', default: 'center', options: [
        { value: 'left', label: 'Izquierda' },
        { value: 'center', label: 'Centrado' },
        { value: 'right', label: 'Derecha' },
      ]},

      { type: 'header', content: 'Icono' },
      { type: 'select', id: 'icon_style', label: 'Estilo', default: 'plain', options: [
        { value: 'plain',  label: 'Sin fondo' },
        { value: 'circle', label: 'Círculo' },
        { value: 'square', label: 'Cuadrado redondeado' },
      ]},
      { type: 'color', id: 'icon_color', label: 'Color del icono', default: '#000000' },
      { type: 'color', id: 'icon_bg', label: 'Color de fondo del badge', default: '#F5F5F5' },
      { type: 'range', id: 'icon_size', label: 'Tamaño del icono', min: 14, max: 64, step: 1, unit: 'px', default: 28 },
      { type: 'range', id: 'badge_size', label: 'Tamaño del badge', min: 24, max: 96, step: 2, unit: 'px', default: 48 },
      { type: 'range', id: 'badge_radius', label: 'Radio (cuadrado)', min: 0, max: 60, step: 1, unit: 'px', default: 12, info: 'Solo aplica si el estilo es "Cuadrado redondeado".' },

      { type: 'header', content: 'Texto del badge' },
      { type: 'color', id: 'label_color', label: 'Color', default: '#111111' },
      { type: 'range', id: 'label_size', label: 'Tamaño', min: 10, max: 20, step: 1, unit: 'px', default: 13 },
      { type: 'select', id: 'label_weight', label: 'Peso', default: '600', options: [
        { value: '400', label: '400' }, { value: '500', label: '500' }, { value: '600', label: '600' }, { value: '700', label: '700' }, { value: '800', label: '800' },
      ]},

      { type: 'header', content: 'Sección' },
      { type: 'color', id: 'bg_color', label: 'Color de fondo', default: '#FFFFFF' },
      { type: 'range', id: 'max_width', label: 'Ancho máximo', min: 300, max: 1600, step: 20, unit: 'px', default: 1200 },
      { type: 'range', id: 'pad_top', label: 'Padding superior', min: 0, max: 80, step: 2, unit: 'px', default: 24 },
      { type: 'range', id: 'pad_bottom', label: 'Padding inferior', min: 0, max: 80, step: 2, unit: 'px', default: 24 },
      { type: 'range', id: 'pad_x', label: 'Padding lateral', min: 0, max: 60, step: 2, unit: 'px', default: 20 },
    ],
    blocks: [
      {
        type: 'badge',
        name: 'Badge',
        settings: [
          { type: 'select', id: 'icon', label: 'Icono', default: 'check', options: iconOptions },
          { type: 'text', id: 'label', label: 'Texto' },
        ],
      },
    ],
    max_blocks: 12,
    presets: [{ name: 'Trust Badges' }],
  };

  const iconCases = ICON_KEYS.map(k => `        {%- when '${k}' -%}${ICON_SET[k]}`).join('\n');

  return `{%- comment -%} Ecom Studio AI — Trust Badges {%- endcomment -%}
{%- assign s = section.settings -%}
{%- assign badge_radius_css = s.badge_radius -%}
{%- if s.icon_style == 'circle' -%}{%- assign badge_radius_css = 999 -%}{%- endif -%}
{%- if s.icon_style == 'plain' -%}
  {%- assign badge_style_css = 'background:transparent;' -%}
{%- else -%}
  {%- assign badge_style_css = 'background:' | append: s.icon_bg | append: ';' -%}
{%- endif -%}
<section class="ecom-studio-trust-badges" style="display:block;background:{{ s.bg_color }};padding:{{ s.pad_top }}px {{ s.pad_x }}px {{ s.pad_bottom }}px">
  <div style="max-width:{{ s.max_width }}px;margin:0 auto;width:100%">
    {%- if s.show_title and s.title != blank -%}
      <h3 style="color:{{ s.title_color }};font-size:{{ s.title_size }}px;text-align:{{ s.title_align }};margin:0 0 {{ s.title_grid_gap }}px;font-weight:700;line-height:1.2">{{ s.title | escape }}</h3>
    {%- endif -%}
    {%- if s.layout == 'grid' -%}
      <div class="ecom-studio-trust-badges__grid" style="display:grid;grid-template-columns:repeat({{ s.columns }}, minmax(0, 1fr));gap:{{ s.item_gap }}px">
    {%- else -%}
      <div class="ecom-studio-trust-badges__row" style="display:flex;flex-wrap:wrap;justify-content:{% if s.item_align == 'left' %}flex-start{% elsif s.item_align == 'right' %}flex-end{% else %}center{% endif %};gap:{{ s.item_gap }}px">
    {%- endif -%}
      {%- for block in section.blocks -%}
        {%- if block.settings.label != blank -%}
          {%- capture icon_inner -%}
            {%- case block.settings.icon -%}
${iconCases}
              {%- else -%}${ICON_SET.check}
            {%- endcase -%}
          {%- endcapture -%}
          <div class="ecom-studio-trust-badges__item" style="display:flex;{% if s.item_direction == 'horizontal' %}flex-direction:row;align-items:center{% else %}flex-direction:column;align-items:{% if s.item_align == 'left' %}flex-start{% elsif s.item_align == 'right' %}flex-end{% else %}center{% endif %};text-align:{{ s.item_align }}{% endif %};gap:10px;{% if s.layout == 'horizontal' %}flex:1 1 auto;min-width:120px;{% endif %}" {{ block.shopify_attributes }}>
            <div style="{{ badge_style_css }}width:{{ s.badge_size }}px;height:{{ s.badge_size }}px;border-radius:{{ badge_radius_css }}px;display:inline-flex;align-items:center;justify-content:center;color:{{ s.icon_color }};flex-shrink:0">
              <svg xmlns="http://www.w3.org/2000/svg" width="{{ s.icon_size }}" height="{{ s.icon_size }}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{{ icon_inner }}</svg>
            </div>
            <span style="color:{{ s.label_color }};font-size:{{ s.label_size }}px;font-weight:{{ s.label_weight }};line-height:1.35">{{ block.settings.label | escape }}</span>
          </div>
        {%- endif -%}
      {%- endfor -%}
    </div>
  </div>
</section>
<style>
  @media (max-width: 720px) {
    .ecom-studio-trust-badges__grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
  }
</style>

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function liveSocialSectionLiquid() {
  const iconOptions = ICON_KEYS.map(k => ({ value: k, label: k.charAt(0).toUpperCase() + k.slice(1) }));
  const schema = {
    name: 'Prueba Social en Vivo',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      { type: 'header', content: 'Mensaje' },
      { type: 'textarea', id: 'message_template', label: 'Mensaje', default: '{count} personas de {city} compraron {product} hoy {date}. Apúrate, solo quedan {stock} unidades en stock.', info: 'Placeholders disponibles: {count}, {city}, {product}, {date}, {stock}. Se reemplazan en vivo en el navegador del cliente.' },

      { type: 'header', content: 'Cantidades aleatorias' },
      { type: 'range', id: 'count_min', label: 'Personas (mínimo)', min: 1, max: 100, step: 1, default: 8 },
      { type: 'range', id: 'count_max', label: 'Personas (máximo)', min: 1, max: 100, step: 1, default: 30 },
      { type: 'range', id: 'stock_min', label: 'Stock (mínimo)', min: 1, max: 100, step: 1, default: 12 },
      { type: 'range', id: 'stock_max', label: 'Stock (máximo)', min: 1, max: 100, step: 1, default: 38 },
      { type: 'range', id: 'refresh_seconds', label: 'Refrescar números cada', min: 0, max: 300, step: 10, unit: 's', default: 0, info: '0 = no refrescar. Útil para simular actividad en vivo.' },

      { type: 'header', content: 'Ciudad (por IP del visitante)' },
      { type: 'checkbox', id: 'detect_ip', label: 'Detectar ciudad por IP automáticamente', default: true, info: 'Llama a una API gratuita (ipwho.is) desde el navegador del cliente.' },
      { type: 'text', id: 'default_city', label: 'Ciudad por defecto', default: 'tu ciudad', info: 'Se muestra mientras se detecta o si falla.' },
      { type: 'textarea', id: 'fallback_cities', label: 'Ciudades de respaldo', default: 'Santiago, Buenos Aires, Lima, Bogotá, Ciudad de México, Madrid', info: 'Separadas por coma. Si la detección IP falla, se elige una al azar de esta lista.' },

      { type: 'header', content: 'Nombre del producto' },
      { type: 'checkbox', id: 'use_product_name', label: 'Usar el nombre del producto de Shopify', default: true },
      { type: 'text', id: 'product_manual', label: 'Nombre manual (si la opción de arriba está desactivada)' },

      { type: 'header', content: 'Fecha' },
      { type: 'select', id: 'date_format', label: 'Formato de la fecha', default: 'long', options: [
        { value: 'long',      label: 'Completa (lunes 17 de mayo 2026)' },
        { value: 'date_only', label: 'Día y mes (17 de mayo)' },
        { value: 'short',     label: 'Numérica (17/05/2026)' },
        { value: 'simple',    label: 'Simple ("hoy")' },
      ]},

      { type: 'header', content: 'Estilo visual' },
      { type: 'select', id: 'variant', label: 'Variante', default: 'pill', options: [
        { value: 'pill',   label: 'Pill (cápsula redondeada)' },
        { value: 'banner', label: 'Banner (rectángulo)' },
        { value: 'card',   label: 'Tarjeta (con sombra)' },
        { value: 'line',   label: 'Línea (sin fondo, solo texto)' },
      ]},
      { type: 'checkbox', id: 'show_icon', label: 'Mostrar icono', default: true },
      { type: 'select', id: 'icon', label: 'Icono', default: 'flame', options: iconOptions },
      { type: 'select', id: 'icon_position', label: 'Posición del icono', default: 'left', options: [
        { value: 'left', label: 'A la izquierda del texto' },
        { value: 'top',  label: 'Arriba del texto' },
      ]},
      { type: 'color', id: 'icon_color', label: 'Color del icono', default: '#EF4444' },
      { type: 'range', id: 'icon_size', label: 'Tamaño del icono', min: 12, max: 40, step: 1, unit: 'px', default: 18 },
      { type: 'color', id: 'bg_color', label: 'Fondo de la pieza', default: '#FEF3C7' },
      { type: 'color', id: 'text_color', label: 'Color del texto', default: '#111111' },
      { type: 'color', id: 'accent_color', label: 'Color de los números resaltados', default: '#EF4444' },
      { type: 'select', id: 'accent_weight', label: 'Peso de los números', default: '700', options: [
        { value: '600', label: '600' }, { value: '700', label: '700' }, { value: '800', label: '800' },
      ]},
      { type: 'color', id: 'border_color', label: 'Color del borde', default: '#F59E0B' },
      { type: 'range', id: 'border_width', label: 'Grosor del borde', min: 0, max: 4, step: 1, unit: 'px', default: 1 },
      { type: 'range', id: 'border_radius', label: 'Radio (no aplica a "Pill")', min: 0, max: 40, step: 1, unit: 'px', default: 12 },
      { type: 'range', id: 'font_size', label: 'Tamaño del texto', min: 10, max: 22, step: 1, unit: 'px', default: 14 },
      { type: 'select', id: 'font_weight', label: 'Peso del texto', default: '500', options: [
        { value: '400', label: '400' }, { value: '500', label: '500' }, { value: '600', label: '600' }, { value: '700', label: '700' },
      ]},
      { type: 'select', id: 'text_align', label: 'Alineación del texto', default: 'center', options: [
        { value: 'left', label: 'Izquierda' },
        { value: 'center', label: 'Centrado' },
        { value: 'right', label: 'Derecha' },
      ]},
      { type: 'range', id: 'padding_v', label: 'Padding vertical', min: 6, max: 32, step: 1, unit: 'px', default: 12 },
      { type: 'range', id: 'padding_h', label: 'Padding horizontal', min: 10, max: 40, step: 2, unit: 'px', default: 18 },
      { type: 'select', id: 'animation', label: 'Animación de aparición', default: 'fade', options: [
        { value: 'none',     label: 'Ninguna' },
        { value: 'fade',     label: 'Aparece con fade' },
        { value: 'slide-up', label: 'Sube y aparece' },
      ]},

      { type: 'header', content: 'Sección' },
      { type: 'color', id: 'sec_bg_color', label: 'Color de fondo de la sección', default: '#FFFFFF' },
      { type: 'range', id: 'max_width', label: 'Ancho máximo', min: 300, max: 1600, step: 20, unit: 'px', default: 1200 },
      { type: 'range', id: 'pad_top', label: 'Padding superior', min: 0, max: 80, step: 2, unit: 'px', default: 16 },
      { type: 'range', id: 'pad_bottom', label: 'Padding inferior', min: 0, max: 80, step: 2, unit: 'px', default: 16 },
      { type: 'range', id: 'pad_x', label: 'Padding lateral', min: 0, max: 60, step: 2, unit: 'px', default: 20 },
    ],
    presets: [{ name: 'Prueba Social en Vivo' }],
  };

  // Inline-SVG icon resolver via {% case %}
  const iconCases = ICON_KEYS.map(k => `        {%- when '${k}' -%}${ICON_SET[k]}`).join('\n');

  return `{%- comment -%} Ecom Studio AI — Prueba Social en Vivo {%- endcomment -%}
{%- assign s = section.settings -%}
{%- assign pill_radius = s.border_radius -%}
{%- if s.variant == 'pill' -%}{%- assign pill_radius = 999 -%}{%- endif -%}
{%- assign piece_bg = s.bg_color -%}
{%- assign piece_shadow = '' -%}
{%- if s.variant == 'card' -%}{%- assign piece_shadow = 'box-shadow:0 2px 8px rgba(0,0,0,.08);' -%}{%- endif -%}
{%- if s.variant == 'line' -%}{%- assign piece_bg = 'transparent' -%}{%- endif -%}
{%- assign piece_border = '' -%}
{%- if s.border_width > 0 and s.variant != 'line' -%}
  {%- assign piece_border = 'border:' | append: s.border_width | append: 'px solid ' | append: s.border_color | append: ';' -%}
{%- endif -%}
{%- if s.use_product_name -%}
  {%- assign product_name = product.title | default: '' -%}
{%- else -%}
  {%- assign product_name = s.product_manual -%}
{%- endif -%}
{%- assign icon_pos_flex = 'row' -%}
{%- assign icon_align_items = 'center' -%}
{%- if s.icon_position == 'top' -%}{%- assign icon_pos_flex = 'column' -%}{%- endif -%}
{%- capture icon_inner -%}
  {%- case s.icon -%}
${iconCases}
    {%- else -%}${ICON_SET.flame}
  {%- endcase -%}
{%- endcapture -%}
<section class="ecom-studio-live-social" style="display:block;background:{{ s.sec_bg_color }};padding:{{ s.pad_top }}px {{ s.pad_x }}px {{ s.pad_bottom }}px">
  <div style="max-width:{{ s.max_width }}px;margin:0 auto;width:100%;text-align:{{ s.text_align }}">
    <div id="ecom-studio-live-social-{{ section.id }}"
         class="ecom-studio-live-social__piece ecom-studio-live-social__anim-{{ s.animation }}"
         data-template="{{ s.message_template | escape }}"
         data-count-min="{{ s.count_min }}"
         data-count-max="{{ s.count_max }}"
         data-stock-min="{{ s.stock_min }}"
         data-stock-max="{{ s.stock_max }}"
         data-refresh="{{ s.refresh_seconds }}"
         data-date-format="{{ s.date_format }}"
         data-fallback-cities="{{ s.fallback_cities | escape }}"
         data-default-city="{{ s.default_city | escape }}"
         data-detect-ip="{% if s.detect_ip %}1{% else %}0{% endif %}"
         data-product="{{ product_name | escape }}"
         data-accent-color="{{ s.accent_color }}"
         data-accent-weight="{{ s.accent_weight }}"
         style="display:inline-flex;flex-direction:{{ icon_pos_flex }};align-items:{{ icon_align_items }};gap:10px;background:{{ piece_bg }};color:{{ s.text_color }};{{ piece_border }}border-radius:{{ pill_radius }}px;padding:{{ s.padding_v }}px {{ s.padding_h }}px;font-size:{{ s.font_size }}px;font-weight:{{ s.font_weight }};line-height:1.5;{{ piece_shadow }}text-align:{{ s.text_align }};max-width:100%">
      {%- if s.show_icon -%}
        <span style="display:inline-flex;align-items:center;justify-content:center;color:{{ s.icon_color }};flex-shrink:0">
          <svg xmlns="http://www.w3.org/2000/svg" width="{{ s.icon_size }}" height="{{ s.icon_size }}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{{ icon_inner }}</svg>
        </span>
      {%- endif -%}
      <span data-es-content>{{ s.message_template | escape }}</span>
    </div>
  </div>
</section>
<style>
  .ecom-studio-live-social__piece [data-es-content] strong { color: var(--es-accent, {{ s.accent_color }}); font-weight: {{ s.accent_weight }}; }
  @keyframes ecom-studio-ls-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes ecom-studio-ls-slide { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  .ecom-studio-live-social__anim-fade     { animation: ecom-studio-ls-fade  .4s ease-out both; }
  .ecom-studio-live-social__anim-slide-up { animation: ecom-studio-ls-slide .45s ease-out both; }
</style>
<script>
(function(){
  var root = document.getElementById('ecom-studio-live-social-{{ section.id }}');
  if (!root || root.__esLiveSocialBound) return;
  root.__esLiveSocialBound = true;
  var template       = root.getAttribute('data-template') || '';
  var countMin       = Number(root.getAttribute('data-count-min')) || 1;
  var countMax       = Number(root.getAttribute('data-count-max')) || 1;
  var stockMin       = Number(root.getAttribute('data-stock-min')) || 1;
  var stockMax       = Number(root.getAttribute('data-stock-max')) || 1;
  var refresh        = Number(root.getAttribute('data-refresh')) || 0;
  var dateFmt        = root.getAttribute('data-date-format') || 'long';
  var detectIp       = root.getAttribute('data-detect-ip') === '1';
  var product        = root.getAttribute('data-product') || '';
  var defaultCity    = root.getAttribute('data-default-city') || '';
  var fallbackRaw    = root.getAttribute('data-fallback-cities') || '';
  var fallbackCities = fallbackRaw.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  var contentEl      = root.querySelector('[data-es-content]');
  if (!contentEl) return;

  // Ensure min <= max
  if (countMin > countMax) { var t = countMin; countMin = countMax; countMax = t; }
  if (stockMin > stockMax) { var t = stockMin; stockMin = stockMax; stockMax = t; }

  function rnd(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  function pad(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function fmtDate(d) {
    var dias  = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    var meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    switch (dateFmt) {
      case 'short':
        return pad(d.getDate()) + '/' + pad(d.getMonth()+1) + '/' + d.getFullYear();
      case 'simple':
        return 'hoy';
      case 'date_only':
        return d.getDate() + ' de ' + meses[d.getMonth()];
      case 'long':
      default:
        return dias[d.getDay()] + ' ' + d.getDate() + ' de ' + meses[d.getMonth()] + ' ' + d.getFullYear();
    }
  }

  var STORAGE_KEY = 'ecom_studio_ls_city_v2';
  var LOG = '[ecom-studio-live-social]';
  var currentCity = defaultCity;
  var cachedCity = null;
  try { cachedCity = sessionStorage.getItem(STORAGE_KEY); } catch(e){}
  if (cachedCity) { currentCity = cachedCity; console.log(LOG, 'usando ciudad cacheada:', cachedCity); }

  function render() {
    var count = rnd(countMin, countMax);
    var stock = rnd(stockMin, stockMax);
    var date  = fmtDate(new Date());
    var html  = escapeHtml(template)
      .replace(/\\{count\\}/g,   '<strong>' + count + '</strong>')
      .replace(/\\{stock\\}/g,   '<strong>' + stock + '</strong>')
      .replace(/\\{city\\}/g,    '<strong>' + escapeHtml(currentCity) + '</strong>')
      .replace(/\\{product\\}/g, '<strong>' + escapeHtml(product || '') + '</strong>')
      .replace(/\\{date\\}/g,    escapeHtml(date));
    contentEl.innerHTML = html;
  }

  render();

  // Cascading city detection — tries 3 free APIs in order.
  function detectCity(callback) {
    var apis = [
      { url: 'https://ipwho.is/',                       parse: function(d){ return (d && d.success !== false && d.city) ? d.city : null; } },
      { url: 'https://ipapi.co/json/',                  parse: function(d){ return (d && !d.error && d.city) ? d.city : null; } },
      { url: 'https://get.geojs.io/v1/ip/geo.json',     parse: function(d){ return (d && d.city) ? d.city : null; } },
    ];
    var i = 0;
    function tryNext() {
      if (i >= apis.length) {
        console.warn(LOG, 'todas las APIs de IP fallaron; usando fallback');
        callback(null);
        return;
      }
      var api = apis[i++];
      fetch(api.url, { method: 'GET', headers: { 'Accept': 'application/json' } })
        .then(function(r){
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function(data){
          var city = api.parse(data);
          if (city) {
            console.log(LOG, 'ciudad detectada:', city, '(via ' + api.url + ')');
            callback(city);
          } else {
            console.warn(LOG, api.url, 'respondió pero sin ciudad. Datos:', data);
            tryNext();
          }
        })
        .catch(function(err){
          console.warn(LOG, api.url, 'falló:', err && err.message);
          tryNext();
        });
    }
    tryNext();
  }

  if (detectIp && !cachedCity) {
    detectCity(function(city){
      if (city) {
        currentCity = city;
        try { sessionStorage.setItem(STORAGE_KEY, currentCity); } catch(e){}
      } else if (fallbackCities.length) {
        currentCity = fallbackCities[rnd(0, fallbackCities.length - 1)];
        console.log(LOG, 'usando ciudad de respaldo aleatoria:', currentCity);
        // NOTE: no se cachea — para que el próximo intento vuelva a probar la API
      }
      render();
    });
  }

  if (refresh > 0) {
    setInterval(render, refresh * 1000);
  }
})();
</script>

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function liveViewersSectionLiquid() {
  const schema = {
    name: 'Visitantes en Vivo',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      { type: 'header', content: 'Mensaje' },
      { type: 'text', id: 'template', label: 'Mensaje', default: '{count} personas viendo este producto ahora', info: 'Usá {count} como placeholder para el número.' },

      { type: 'header', content: 'Cantidades aleatorias' },
      { type: 'range', id: 'count_min', label: 'Personas (mín.)', min: 1, max: 100, step: 1, default: 5 },
      { type: 'range', id: 'count_max', label: 'Personas (máx.)', min: 1, max: 100, step: 1, default: 25 },
      { type: 'range', id: 'refresh_seconds', label: 'Refrescar cada', min: 3, max: 60, step: 1, unit: 's', default: 12 },
      { type: 'range', id: 'drift', label: 'Variación entre refrescos', min: 0, max: 5, step: 1, unit: '±', default: 2, info: 'El número se mueve ±N entre refrescos en vez de saltar al azar, para verse orgánico.' },

      { type: 'header', content: 'Punto pulsante' },
      { type: 'checkbox', id: 'show_dot', label: 'Mostrar punto rojo', default: true },
      { type: 'color', id: 'dot_color', label: 'Color del punto', default: '#EF4444' },
      { type: 'range', id: 'dot_size', label: 'Tamaño del punto', min: 4, max: 20, step: 1, unit: 'px', default: 8 },
      { type: 'checkbox', id: 'dot_pulse', label: 'Animar (pulsar)', default: true },

      { type: 'header', content: 'Estilo visual' },
      { type: 'select', id: 'variant', label: 'Variante', default: 'pill', options: [
        { value: 'pill',   label: 'Pill (cápsula)' },
        { value: 'banner', label: 'Banner (rectángulo)' },
        { value: 'line',   label: 'Línea (sin fondo)' },
      ]},
      { type: 'color', id: 'bg_color', label: 'Fondo', default: '#FEF2F2' },
      { type: 'color', id: 'text_color', label: 'Color del texto', default: '#111111' },
      { type: 'color', id: 'accent_color', label: 'Color del número', default: '#EF4444' },
      { type: 'select', id: 'accent_weight', label: 'Peso del número', default: '700', options: [
        { value: '600', label: '600' }, { value: '700', label: '700' }, { value: '800', label: '800' },
      ]},
      { type: 'color', id: 'border_color', label: 'Borde', default: '#FCA5A5' },
      { type: 'range', id: 'border_width', label: 'Grosor borde', min: 0, max: 4, step: 1, unit: 'px', default: 1 },
      { type: 'range', id: 'border_radius', label: 'Radio (no aplica a Pill)', min: 0, max: 40, step: 1, unit: 'px', default: 12 },
      { type: 'range', id: 'font_size', label: 'Tamaño del texto', min: 10, max: 20, step: 1, unit: 'px', default: 13 },
      { type: 'select', id: 'font_weight', label: 'Peso del texto', default: '500', options: [
        { value: '400', label: '400' }, { value: '500', label: '500' }, { value: '600', label: '600' }, { value: '700', label: '700' },
      ]},
      { type: 'select', id: 'text_align', label: 'Alineación', default: 'center', options: [
        { value: 'left', label: 'Izquierda' }, { value: 'center', label: 'Centrado' }, { value: 'right', label: 'Derecha' },
      ]},
      { type: 'range', id: 'padding_v', label: 'Padding vertical', min: 4, max: 24, step: 1, unit: 'px', default: 8 },
      { type: 'range', id: 'padding_h', label: 'Padding horizontal', min: 8, max: 32, step: 1, unit: 'px', default: 14 },
      { type: 'select', id: 'animation', label: 'Animación de aparición', default: 'fade', options: [
        { value: 'none', label: 'Ninguna' }, { value: 'fade', label: 'Fade' }, { value: 'slide-up', label: 'Subir y aparecer' },
      ]},

      { type: 'header', content: 'Sección' },
      { type: 'color', id: 'sec_bg_color', label: 'Color de fondo de la sección', default: '#FFFFFF' },
      { type: 'range', id: 'max_width', label: 'Ancho máximo', min: 300, max: 1600, step: 20, unit: 'px', default: 1200 },
      { type: 'range', id: 'pad_top', label: 'Padding superior', min: 0, max: 60, step: 2, unit: 'px', default: 12 },
      { type: 'range', id: 'pad_bottom', label: 'Padding inferior', min: 0, max: 60, step: 2, unit: 'px', default: 12 },
      { type: 'range', id: 'pad_x', label: 'Padding lateral', min: 0, max: 60, step: 2, unit: 'px', default: 20 },
    ],
    presets: [{ name: 'Visitantes en Vivo' }],
  };

  return `{%- comment -%} Ecom Studio AI — Visitantes en Vivo {%- endcomment -%}
{%- assign s = section.settings -%}
{%- assign pill_radius = s.border_radius -%}
{%- if s.variant == 'pill' -%}{%- assign pill_radius = 999 -%}{%- endif -%}
{%- assign piece_bg = s.bg_color -%}
{%- if s.variant == 'line' -%}{%- assign piece_bg = 'transparent' -%}{%- endif -%}
{%- assign piece_border = '' -%}
{%- if s.border_width > 0 and s.variant != 'line' -%}
  {%- assign piece_border = 'border:' | append: s.border_width | append: 'px solid ' | append: s.border_color | append: ';' -%}
{%- endif -%}
<section class="ecom-studio-live-viewers" style="display:block;background:{{ s.sec_bg_color }};padding:{{ s.pad_top }}px {{ s.pad_x }}px {{ s.pad_bottom }}px">
  <div style="max-width:{{ s.max_width }}px;margin:0 auto;width:100%;text-align:{{ s.text_align }}">
    <div id="ecom-studio-live-viewers-{{ section.id }}"
         class="ecom-studio-live-viewers__piece ecom-studio-live-viewers__anim-{{ s.animation }}"
         data-template="{{ s.template | escape }}"
         data-count-min="{{ s.count_min }}"
         data-count-max="{{ s.count_max }}"
         data-refresh="{{ s.refresh_seconds }}"
         data-drift="{{ s.drift }}"
         data-accent-color="{{ s.accent_color }}"
         data-accent-weight="{{ s.accent_weight }}"
         style="display:inline-flex;align-items:center;gap:8px;background:{{ piece_bg }};color:{{ s.text_color }};{{ piece_border }}border-radius:{{ pill_radius }}px;padding:{{ s.padding_v }}px {{ s.padding_h }}px;font-size:{{ s.font_size }}px;font-weight:{{ s.font_weight }};line-height:1.4;max-width:100%">
      {%- if s.show_dot -%}
        <span class="ecom-studio-live-viewers__dot{% if s.dot_pulse %} ecom-studio-live-viewers__dot--pulse{% endif %}" style="display:inline-block;width:{{ s.dot_size }}px;height:{{ s.dot_size }}px;border-radius:999px;background:{{ s.dot_color }};flex-shrink:0"></span>
      {%- endif -%}
      <span data-es-content>{{ s.template | escape }}</span>
    </div>
  </div>
</section>
<style>
  .ecom-studio-live-viewers__piece [data-es-content] strong { color: {{ s.accent_color }}; font-weight: {{ s.accent_weight }}; }
  @keyframes ecom-studio-lv-pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.4); opacity: .55; } }
  @keyframes ecom-studio-lv-fade  { from { opacity: 0; } to { opacity: 1; } }
  @keyframes ecom-studio-lv-slide { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  .ecom-studio-live-viewers__dot--pulse { animation: ecom-studio-lv-pulse 1.4s ease-in-out infinite; }
  .ecom-studio-live-viewers__anim-fade     { animation: ecom-studio-lv-fade  .4s ease-out both; }
  .ecom-studio-live-viewers__anim-slide-up { animation: ecom-studio-lv-slide .45s ease-out both; }
</style>
<script>
(function(){
  var root = document.getElementById('ecom-studio-live-viewers-{{ section.id }}');
  if (!root || root.__esLvBound) return;
  root.__esLvBound = true;
  var template = root.getAttribute('data-template') || '';
  var min      = Number(root.getAttribute('data-count-min')) || 1;
  var max      = Number(root.getAttribute('data-count-max')) || 1;
  var refresh  = Number(root.getAttribute('data-refresh')) || 12;
  var drift    = Number(root.getAttribute('data-drift')) || 0;
  if (min > max) { var t = min; min = max; max = t; }
  var contentEl = root.querySelector('[data-es-content]');
  if (!contentEl) return;
  function rnd(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  var current = rnd(min, max);
  function render() {
    contentEl.innerHTML = escapeHtml(template).replace(/\\{count\\}/g, '<strong>' + current + '</strong>');
  }
  render();
  setInterval(function(){
    if (drift > 0) {
      var delta = rnd(-drift, drift);
      var next = current + delta;
      if (next < min) next = min;
      if (next > max) next = max;
      if (next === current) next = next < max ? next + 1 : next - 1; // ensure visible change
      current = next;
    } else {
      var newVal = rnd(min, max);
      if (newVal === current && min !== max) newVal = newVal === max ? newVal - 1 : newVal + 1;
      current = newVal;
    }
    render();
  }, refresh * 1000);
})();
</script>

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function shippingClockSectionLiquid() {
  const iconOptions = ICON_KEYS.map(k => ({ value: k, label: k.charAt(0).toUpperCase() + k.slice(1) }));
  const schema = {
    name: 'Reloj de Envío',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      { type: 'header', content: 'Hora de corte' },
      { type: 'range', id: 'cutoff_hour', label: 'Hora de corte (0-23)', min: 0, max: 23, step: 1, default: 17, info: 'Hora local del visitante. Antes del corte → mensaje "antes". Después → mensaje "después".' },
      { type: 'range', id: 'cutoff_minute', label: 'Minuto de corte', min: 0, max: 59, step: 1, default: 0 },
      { type: 'checkbox', id: 'skip_weekends', label: 'Tratar fines de semana como cerrado', default: false, info: 'Si está activo, los sábados y domingos siempre muestran el mensaje "después".' },

      { type: 'header', content: 'Mensajes' },
      { type: 'textarea', id: 'before_message', label: 'Antes del corte', default: 'Pedí en las próximas {time} y recibilo mañana', info: 'Usá {time} como placeholder para el contador (ej. "2h 15min").' },
      { type: 'textarea', id: 'after_message', label: 'Después del corte', default: 'Hoy ya cerramos. Comprá ahora y te llega pasado mañana' },

      { type: 'header', content: 'Icono' },
      { type: 'checkbox', id: 'show_icon', label: 'Mostrar icono', default: true },
      { type: 'select', id: 'icon', label: 'Icono', default: 'truck', options: iconOptions },
      { type: 'color', id: 'icon_color', label: 'Color del icono', default: '#10B981' },
      { type: 'range', id: 'icon_size', label: 'Tamaño del icono', min: 12, max: 40, step: 1, unit: 'px', default: 18 },

      { type: 'header', content: 'Estilo visual' },
      { type: 'select', id: 'variant', label: 'Variante', default: 'pill', options: [
        { value: 'pill',   label: 'Pill (cápsula)' },
        { value: 'banner', label: 'Banner (rectángulo)' },
        { value: 'card',   label: 'Tarjeta (con sombra)' },
        { value: 'line',   label: 'Línea (sin fondo)' },
      ]},
      { type: 'color', id: 'bg_color', label: 'Fondo', default: '#ECFDF5' },
      { type: 'color', id: 'text_color', label: 'Color del texto', default: '#111111' },
      { type: 'color', id: 'accent_color', label: 'Color del {time} resaltado', default: '#10B981' },
      { type: 'select', id: 'accent_weight', label: 'Peso del {time}', default: '700', options: [
        { value: '600', label: '600' }, { value: '700', label: '700' }, { value: '800', label: '800' },
      ]},
      { type: 'color', id: 'border_color', label: 'Borde', default: '#10B981' },
      { type: 'range', id: 'border_width', label: 'Grosor borde', min: 0, max: 4, step: 1, unit: 'px', default: 1 },
      { type: 'range', id: 'border_radius', label: 'Radio (no aplica a Pill)', min: 0, max: 40, step: 1, unit: 'px', default: 12 },
      { type: 'range', id: 'font_size', label: 'Tamaño del texto', min: 11, max: 22, step: 1, unit: 'px', default: 14 },
      { type: 'select', id: 'font_weight', label: 'Peso del texto', default: '500', options: [
        { value: '400', label: '400' }, { value: '500', label: '500' }, { value: '600', label: '600' }, { value: '700', label: '700' },
      ]},
      { type: 'select', id: 'text_align', label: 'Alineación', default: 'center', options: [
        { value: 'left', label: 'Izquierda' }, { value: 'center', label: 'Centrado' }, { value: 'right', label: 'Derecha' },
      ]},
      { type: 'range', id: 'padding_v', label: 'Padding vertical', min: 6, max: 32, step: 1, unit: 'px', default: 12 },
      { type: 'range', id: 'padding_h', label: 'Padding horizontal', min: 10, max: 40, step: 2, unit: 'px', default: 18 },

      { type: 'header', content: 'Sección' },
      { type: 'color', id: 'sec_bg_color', label: 'Color de fondo de la sección', default: '#FFFFFF' },
      { type: 'range', id: 'max_width', label: 'Ancho máximo', min: 300, max: 1600, step: 20, unit: 'px', default: 1200 },
      { type: 'range', id: 'pad_top', label: 'Padding superior', min: 0, max: 80, step: 2, unit: 'px', default: 16 },
      { type: 'range', id: 'pad_bottom', label: 'Padding inferior', min: 0, max: 80, step: 2, unit: 'px', default: 16 },
      { type: 'range', id: 'pad_x', label: 'Padding lateral', min: 0, max: 60, step: 2, unit: 'px', default: 20 },
    ],
    presets: [{ name: 'Reloj de Envío' }],
  };

  const iconCases = ICON_KEYS.map(k => `        {%- when '${k}' -%}${ICON_SET[k]}`).join('\n');

  return `{%- comment -%} Ecom Studio AI — Reloj de Envío {%- endcomment -%}
{%- assign s = section.settings -%}
{%- assign pill_radius = s.border_radius -%}
{%- if s.variant == 'pill' -%}{%- assign pill_radius = 999 -%}{%- endif -%}
{%- assign piece_bg = s.bg_color -%}
{%- assign piece_shadow = '' -%}
{%- if s.variant == 'card' -%}{%- assign piece_shadow = 'box-shadow:0 2px 8px rgba(0,0,0,.08);' -%}{%- endif -%}
{%- if s.variant == 'line' -%}{%- assign piece_bg = 'transparent' -%}{%- endif -%}
{%- assign piece_border = '' -%}
{%- if s.border_width > 0 and s.variant != 'line' -%}
  {%- assign piece_border = 'border:' | append: s.border_width | append: 'px solid ' | append: s.border_color | append: ';' -%}
{%- endif -%}
{%- capture icon_inner -%}
  {%- case s.icon -%}
${iconCases}
    {%- else -%}${ICON_SET.truck}
  {%- endcase -%}
{%- endcapture -%}
<section class="ecom-studio-shipping-clock" style="display:block;background:{{ s.sec_bg_color }};padding:{{ s.pad_top }}px {{ s.pad_x }}px {{ s.pad_bottom }}px">
  <div style="max-width:{{ s.max_width }}px;margin:0 auto;width:100%;text-align:{{ s.text_align }}">
    <div id="ecom-studio-shipping-clock-{{ section.id }}"
         class="ecom-studio-shipping-clock__piece"
         data-cutoff-hour="{{ s.cutoff_hour }}"
         data-cutoff-minute="{{ s.cutoff_minute }}"
         data-skip-weekends="{% if s.skip_weekends %}1{% else %}0{% endif %}"
         data-before="{{ s.before_message | escape }}"
         data-after="{{ s.after_message | escape }}"
         data-accent-color="{{ s.accent_color }}"
         data-accent-weight="{{ s.accent_weight }}"
         style="display:inline-flex;align-items:center;gap:10px;background:{{ piece_bg }};color:{{ s.text_color }};{{ piece_border }}border-radius:{{ pill_radius }}px;padding:{{ s.padding_v }}px {{ s.padding_h }}px;font-size:{{ s.font_size }}px;font-weight:{{ s.font_weight }};line-height:1.5;{{ piece_shadow }}max-width:100%">
      {%- if s.show_icon -%}
        <span style="display:inline-flex;align-items:center;justify-content:center;color:{{ s.icon_color }};flex-shrink:0">
          <svg xmlns="http://www.w3.org/2000/svg" width="{{ s.icon_size }}" height="{{ s.icon_size }}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{{ icon_inner }}</svg>
        </span>
      {%- endif -%}
      <span data-es-content>{{ s.before_message | escape }}</span>
    </div>
  </div>
</section>
<style>
  .ecom-studio-shipping-clock__piece [data-es-content] strong { color: {{ s.accent_color }}; font-weight: {{ s.accent_weight }}; }
</style>
<script>
(function(){
  var root = document.getElementById('ecom-studio-shipping-clock-{{ section.id }}');
  if (!root || root.__esShBound) return;
  root.__esShBound = true;
  var cutoffH      = Number(root.getAttribute('data-cutoff-hour')) || 17;
  var cutoffM      = Number(root.getAttribute('data-cutoff-minute')) || 0;
  var skipWeekends = root.getAttribute('data-skip-weekends') === '1';
  var beforeTpl    = root.getAttribute('data-before') || '';
  var afterTpl     = root.getAttribute('data-after')  || '';
  var contentEl    = root.querySelector('[data-es-content]');
  if (!contentEl) return;
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function fmtTime(ms) {
    var totalMin = Math.floor(ms / 60000);
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    if (h > 0) return h + 'h ' + (m < 10 ? '0' + m : m) + 'min';
    return m + 'min';
  }
  function isWeekend(d) { var day = d.getDay(); return day === 0 || day === 6; }
  function render() {
    var now = new Date();
    var cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), cutoffH, cutoffM, 0, 0);
    var pastCutoff = now >= cutoff;
    var useAfter = pastCutoff || (skipWeekends && isWeekend(now));
    if (useAfter) {
      contentEl.innerHTML = escapeHtml(afterTpl).replace(/\\{time\\}/g, '');
    } else {
      var remaining = cutoff - now;
      contentEl.innerHTML = escapeHtml(beforeTpl).replace(/\\{time\\}/g, '<strong>' + fmtTime(remaining) + '</strong>');
    }
  }
  render();
  setInterval(render, 30000);
})();
</script>

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function purchasePopupSectionLiquid() {
  const iconOptions = ICON_KEYS.map(k => ({ value: k, label: k.charAt(0).toUpperCase() + k.slice(1) }));
  const schema = {
    name: 'Notificación de Compra',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      { type: 'header', content: 'Mensaje' },
      { type: 'textarea', id: 'message_template', label: 'Plantilla del mensaje', default: '{name} de {city} compró {product} hace {time}', info: 'Placeholders: {name}, {city}, {product}, {time}. {time} se genera al azar (ej. "hace 5 minutos").' },

      { type: 'header', content: 'Posición' },
      { type: 'select', id: 'position', label: 'Esquina', default: 'bottom-left', options: [
        { value: 'bottom-left',  label: 'Abajo a la izquierda' },
        { value: 'bottom-right', label: 'Abajo a la derecha' },
        { value: 'top-left',     label: 'Arriba a la izquierda' },
        { value: 'top-right',    label: 'Arriba a la derecha' },
      ]},
      { type: 'range', id: 'offset_x', label: 'Distancia horizontal al borde', min: 0, max: 80, step: 2, unit: 'px', default: 16 },
      { type: 'range', id: 'offset_y', label: 'Distancia vertical al borde', min: 0, max: 80, step: 2, unit: 'px', default: 16 },
      { type: 'range', id: 'z_index', label: 'Capa (z-index)', min: 50, max: 5000, step: 50, default: 100, info: 'Subí este valor si la notificación queda tapada por otros elementos del tema.' },

      { type: 'header', content: 'Tiempos' },
      { type: 'range', id: 'initial_delay_seconds', label: 'Esperar antes del primero', min: 0, max: 30, step: 1, unit: 's', default: 5 },
      { type: 'range', id: 'visible_seconds', label: 'Tiempo visible cada notificación', min: 2, max: 15, step: 1, unit: 's', default: 5 },
      { type: 'range', id: 'hidden_seconds', label: 'Tiempo oculto entre notificaciones', min: 3, max: 60, step: 1, unit: 's', default: 12 },
      { type: 'range', id: 'max_cycles', label: 'Máximo de ciclos completos (0 = infinito)', min: 0, max: 50, step: 1, default: 0 },
      { type: 'checkbox', id: 'random_order', label: 'Orden aleatorio', default: true },
      { type: 'range', id: 'time_ago_min', label: 'Tiempo atrás (mín. en minutos)', min: 0, max: 180, step: 5, default: 5 },
      { type: 'range', id: 'time_ago_max', label: 'Tiempo atrás (máx. en minutos)', min: 0, max: 180, step: 5, default: 30 },

      { type: 'header', content: 'Nombre del producto' },
      { type: 'checkbox', id: 'use_product_name', label: 'Usar el nombre del producto de Shopify', default: true },
      { type: 'text', id: 'product_manual', label: 'Nombre manual' },

      { type: 'header', content: 'Avatar (iniciales)' },
      { type: 'checkbox', id: 'show_avatar', label: 'Mostrar avatar con iniciales', default: true },
      { type: 'color', id: 'avatar_bg', label: 'Fondo avatar', default: '#F59E0B' },
      { type: 'color', id: 'avatar_color', label: 'Color del texto del avatar', default: '#FFFFFF' },
      { type: 'range', id: 'avatar_size', label: 'Tamaño del avatar', min: 24, max: 64, step: 2, unit: 'px', default: 38 },

      { type: 'header', content: 'Icono opcional' },
      { type: 'checkbox', id: 'show_icon', label: 'Mostrar icono pequeño junto al avatar', default: false },
      { type: 'select', id: 'icon', label: 'Icono', default: 'package', options: iconOptions },
      { type: 'color', id: 'icon_color', label: 'Color', default: '#22C55E' },
      { type: 'range', id: 'icon_size', label: 'Tamaño', min: 10, max: 30, step: 1, unit: 'px', default: 16 },

      { type: 'header', content: 'Tarjeta' },
      { type: 'color', id: 'card_bg', label: 'Fondo', default: '#FFFFFF' },
      { type: 'color', id: 'card_border', label: 'Borde', default: '#E5E7EB' },
      { type: 'range', id: 'card_border_width', label: 'Grosor del borde', min: 0, max: 4, step: 1, unit: 'px', default: 1 },
      { type: 'range', id: 'card_radius', label: 'Radio', min: 0, max: 32, step: 1, unit: 'px', default: 12 },
      { type: 'range', id: 'card_padding', label: 'Padding interno', min: 8, max: 24, step: 1, unit: 'px', default: 14 },
      { type: 'range', id: 'card_width', label: 'Ancho de la tarjeta', min: 220, max: 420, step: 4, unit: 'px', default: 320 },

      { type: 'header', content: 'Texto' },
      { type: 'color', id: 'name_color', label: 'Color del nombre', default: '#111111' },
      { type: 'range', id: 'name_size', label: 'Tamaño del nombre', min: 11, max: 20, step: 1, unit: 'px', default: 14 },
      { type: 'select', id: 'name_weight', label: 'Peso del nombre', default: '700', options: [
        { value: '500', label: '500' }, { value: '600', label: '600' }, { value: '700', label: '700' },
      ]},
      { type: 'color', id: 'text_color', label: 'Color del texto', default: '#444444' },
      { type: 'range', id: 'text_size', label: 'Tamaño del texto', min: 10, max: 16, step: 1, unit: 'px', default: 12 },
      { type: 'color', id: 'time_color', label: 'Color del "hace X tiempo"', default: '#888888' },
      { type: 'range', id: 'time_size', label: 'Tamaño del tiempo', min: 9, max: 14, step: 1, unit: 'px', default: 11 },

      { type: 'header', content: 'Comportamiento' },
      { type: 'checkbox', id: 'show_close', label: 'Mostrar botón de cerrar (×)', default: true, info: 'Si el visitante cierra una notificación, no se vuelven a mostrar en esa sesión.' },
      { type: 'color', id: 'close_color', label: 'Color del botón cerrar', default: '#999999' },
      { type: 'select', id: 'animation', label: 'Animación de aparición', default: 'slide-in-left', options: [
        { value: 'fade',           label: 'Fade' },
        { value: 'slide-in-left',  label: 'Deslizar desde la izquierda' },
        { value: 'slide-in-right', label: 'Deslizar desde la derecha' },
        { value: 'slide-in-up',    label: 'Subir desde abajo' },
      ]},
    ],
    blocks: [
      {
        type: 'purchase',
        name: 'Comprador',
        settings: [
          { type: 'text', id: 'name', label: 'Nombre' },
          { type: 'text', id: 'city', label: 'Ciudad' },
        ],
      },
    ],
    max_blocks: 20,
    presets: [{ name: 'Notificación de Compra' }],
  };

  const iconCases = ICON_KEYS.map(k => `        {%- when '${k}' -%}${ICON_SET[k]}`).join('\n');

  return `{%- comment -%} Ecom Studio AI — Notificación Flotante de Compra {%- endcomment -%}
{%- assign s = section.settings -%}
{%- if s.use_product_name -%}
  {%- assign product_name = product.title | default: '' -%}
{%- else -%}
  {%- assign product_name = s.product_manual -%}
{%- endif -%}
{%- capture icon_inner -%}
  {%- case s.icon -%}
${iconCases}
    {%- else -%}${ICON_SET.package}
  {%- endcase -%}
{%- endcapture -%}
{%- assign pos_styles = '' -%}
{%- case s.position -%}
  {%- when 'bottom-left'  -%}{%- assign pos_styles = 'bottom:' | append: s.offset_y | append: 'px;left:'  | append: s.offset_x | append: 'px;' -%}
  {%- when 'bottom-right' -%}{%- assign pos_styles = 'bottom:' | append: s.offset_y | append: 'px;right:' | append: s.offset_x | append: 'px;' -%}
  {%- when 'top-left'     -%}{%- assign pos_styles = 'top:'    | append: s.offset_y | append: 'px;left:'  | append: s.offset_x | append: 'px;' -%}
  {%- when 'top-right'    -%}{%- assign pos_styles = 'top:'    | append: s.offset_y | append: 'px;right:' | append: s.offset_x | append: 'px;' -%}
{%- endcase -%}
{%- capture items_json -%}[{%- for block in section.blocks -%}{%- if block.settings.name != blank -%}{"name":"{{ block.settings.name | escape | replace: '"', '\\"' }}","city":"{{ block.settings.city | escape | replace: '"', '\\"' }}"}{%- unless forloop.last -%},{%- endunless -%}{%- endif -%}{%- endfor -%}]{%- endcapture -%}
<div id="ecom-studio-purchase-popup-{{ section.id }}"
     class="ecom-studio-purchase-popup"
     data-template="{{ s.message_template | escape }}"
     data-items='{{ items_json }}'
     data-initial-delay="{{ s.initial_delay_seconds }}"
     data-visible-secs="{{ s.visible_seconds }}"
     data-hidden-secs="{{ s.hidden_seconds }}"
     data-max-cycles="{{ s.max_cycles }}"
     data-random-order="{% if s.random_order %}1{% else %}0{% endif %}"
     data-time-min="{{ s.time_ago_min }}"
     data-time-max="{{ s.time_ago_max }}"
     data-product="{{ product_name | escape }}"
     data-animation="{{ s.animation }}"
     style="position:fixed;{{ pos_styles }}z-index:{{ s.z_index }};display:none;width:{{ s.card_width }}px;max-width:calc(100vw - 24px);background:{{ s.card_bg }};border:{{ s.card_border_width }}px solid {{ s.card_border }};border-radius:{{ s.card_radius }}px;padding:{{ s.card_padding }}px;box-shadow:0 4px 16px rgba(0,0,0,.12);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif">
  <div style="display:flex;align-items:center;gap:10px">
    {%- if s.show_avatar -%}
      <div data-es-avatar style="flex-shrink:0;width:{{ s.avatar_size }}px;height:{{ s.avatar_size }}px;border-radius:999px;background:{{ s.avatar_bg }};color:{{ s.avatar_color }};display:inline-flex;align-items:center;justify-content:center;font-size:{{ s.avatar_size | times: 0.4 | round }}px;font-weight:700;line-height:1">?</div>
    {%- endif -%}
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
        {%- if s.show_icon -%}
          <span style="display:inline-flex;align-items:center;color:{{ s.icon_color }};flex-shrink:0">
            <svg xmlns="http://www.w3.org/2000/svg" width="{{ s.icon_size }}" height="{{ s.icon_size }}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{{ icon_inner }}</svg>
          </span>
        {%- endif -%}
        <span data-es-content style="color:{{ s.text_color }};font-size:{{ s.text_size }}px;line-height:1.4"></span>
      </div>
      <div data-es-time style="color:{{ s.time_color }};font-size:{{ s.time_size }}px;line-height:1.2"></div>
    </div>
    {%- if s.show_close -%}
      <button type="button" data-es-close aria-label="Cerrar" style="background:transparent;border:0;cursor:pointer;color:{{ s.close_color }};padding:2px;line-height:0;flex-shrink:0">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    {%- endif -%}
  </div>
</div>
<style>
  #ecom-studio-purchase-popup-{{ section.id }} [data-es-content] strong { color:{{ s.name_color }}; font-size:{{ s.name_size }}px; font-weight:{{ s.name_weight }}; }
  @keyframes ecom-studio-pp-fade  { from { opacity: 0; } to { opacity: 1; } }
  @keyframes ecom-studio-pp-slL   { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes ecom-studio-pp-slR   { from { opacity: 0; transform: translateX(20px); }  to { opacity: 1; transform: translateX(0); } }
  @keyframes ecom-studio-pp-slU   { from { opacity: 0; transform: translateY(20px); }  to { opacity: 1; transform: translateY(0); } }
  .ecom-studio-purchase-popup.anim-fade           { animation: ecom-studio-pp-fade .35s ease-out both; }
  .ecom-studio-purchase-popup.anim-slide-in-left  { animation: ecom-studio-pp-slL  .4s  ease-out both; }
  .ecom-studio-purchase-popup.anim-slide-in-right { animation: ecom-studio-pp-slR  .4s  ease-out both; }
  .ecom-studio-purchase-popup.anim-slide-in-up    { animation: ecom-studio-pp-slU  .4s  ease-out both; }
</style>
<script>
(function(){
  var root = document.getElementById('ecom-studio-purchase-popup-{{ section.id }}');
  if (!root || root.__esPpBound) return;
  root.__esPpBound = true;
  var SESSION_KEY = 'ecom_studio_pp_closed_{{ section.id }}';
  try { if (sessionStorage.getItem(SESSION_KEY) === '1') return; } catch(e){}

  var itemsRaw = root.getAttribute('data-items') || '[]';
  var items;
  try { items = JSON.parse(itemsRaw); } catch(e) { items = []; }
  if (!items.length) return;

  var template      = root.getAttribute('data-template') || '';
  var initialDelay  = (Number(root.getAttribute('data-initial-delay')) || 5) * 1000;
  var visibleMs     = (Number(root.getAttribute('data-visible-secs')) || 5) * 1000;
  var hiddenMs      = (Number(root.getAttribute('data-hidden-secs')) || 12) * 1000;
  var maxCycles     = Number(root.getAttribute('data-max-cycles')) || 0;
  var randomOrder   = root.getAttribute('data-random-order') === '1';
  var timeMin       = Number(root.getAttribute('data-time-min')) || 2;
  var timeMax       = Number(root.getAttribute('data-time-max')) || 30;
  var product       = root.getAttribute('data-product') || '';
  var animation     = root.getAttribute('data-animation') || 'slide-in-left';

  var contentEl = root.querySelector('[data-es-content]');
  var timeEl    = root.querySelector('[data-es-time]');
  var avatarEl  = root.querySelector('[data-es-avatar]');
  var closeBtn  = root.querySelector('[data-es-close]');

  function rnd(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function initials(name) {
    var parts = String(name || '').trim().split(/\\s+/).filter(Boolean);
    if (!parts.length) return '?';
    var f = parts[0][0] || '';
    var l = parts.length > 1 ? (parts[parts.length-1][0] || '') : '';
    return (f + l).toUpperCase();
  }
  function fmtTimeAgo(min) {
    if (min < 60) return 'hace ' + min + ' minutos';
    var h = Math.floor(min / 60);
    if (h === 1) return 'hace 1 hora';
    if (h < 24) return 'hace ' + h + ' horas';
    return 'hace 1 día';
  }

  // Build queue
  var queue = items.slice();
  if (randomOrder) {
    for (var i = queue.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = queue[i]; queue[i] = queue[j]; queue[j] = tmp;
    }
  }

  var idx = 0;
  var cycle = 0;

  function showOne() {
    var it = queue[idx];
    var minAgo = rnd(timeMin, timeMax);
    var timeText = fmtTimeAgo(minAgo);

    var html = escapeHtml(template)
      .replace(/\\{name\\}/g,    '<strong>' + escapeHtml(it.name || '') + '</strong>')
      .replace(/\\{city\\}/g,    '<strong>' + escapeHtml(it.city || '') + '</strong>')
      .replace(/\\{product\\}/g, '<strong>' + escapeHtml(product || '') + '</strong>')
      .replace(/\\{time\\}/g,    escapeHtml(timeText));
    if (contentEl) contentEl.innerHTML = html;
    if (timeEl) timeEl.textContent = timeText;
    if (avatarEl) avatarEl.textContent = initials(it.name);

    root.style.display = 'block';
    root.classList.remove('anim-fade','anim-slide-in-left','anim-slide-in-right','anim-slide-in-up');
    void root.offsetWidth; // force reflow to restart animation
    root.classList.add('anim-' + animation);

    setTimeout(function(){
      root.style.display = 'none';
      idx++;
      if (idx >= queue.length) {
        idx = 0;
        cycle++;
        if (maxCycles > 0 && cycle >= maxCycles) return;
      }
      setTimeout(showOne, hiddenMs);
    }, visibleMs);
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', function(){
      root.style.display = 'none';
      try { sessionStorage.setItem(SESSION_KEY, '1'); } catch(e){}
    });
  }

  setTimeout(showOne, initialDelay);
})();
</script>

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function productHeroSectionLiquid() {
  const iconOptions = ICON_KEYS.map(k => ({ value: k, label: k.charAt(0).toUpperCase() + k.slice(1) }));
  const schema = {
    name: 'Hero de Producto',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      { type: 'header', content: 'Rating con estrellas' },
      { type: 'checkbox', id: 'show_rating', label: 'Mostrar rating', default: true },
      { type: 'range', id: 'rating', label: 'Estrellas (0-5)', min: 0, max: 5, step: 1, default: 5 },
      { type: 'number', id: 'review_count', label: 'Cantidad de reseñas', default: 287 },
      { type: 'text', id: 'review_format', label: 'Formato del texto', default: '{count} reseñas', info: 'Usá {count} como placeholder.' },
      { type: 'color', id: 'star_color', label: 'Color estrellas', default: '#F59E0B' },
      { type: 'range', id: 'star_size', label: 'Tamaño estrellas', min: 10, max: 28, step: 1, unit: 'px', default: 16 },

      { type: 'header', content: 'Título' },
      { type: 'checkbox', id: 'use_product_name', label: 'Usar nombre del producto de Shopify', default: true },
      { type: 'text', id: 'title_manual', label: 'Nombre manual (si no usás Shopify)' },
      { type: 'color', id: 'title_color', label: 'Color', default: '#000000' },
      { type: 'range', id: 'title_size', label: 'Tamaño', min: 18, max: 48, step: 1, unit: 'px', default: 32 },
      { type: 'select', id: 'title_weight', label: 'Peso', default: '800', options: [
        { value: '600', label: '600' }, { value: '700', label: '700' }, { value: '800', label: '800' }, { value: '900', label: '900' },
      ]},

      { type: 'header', content: 'Subtítulo / propuesta de valor' },
      { type: 'textarea', id: 'subtitle', label: 'Subtítulo', default: 'Frescura interior diaria que eleva tu confianza y presencia social' },
      { type: 'color', id: 'subtitle_color', label: 'Color', default: '#111111' },
      { type: 'range', id: 'subtitle_size', label: 'Tamaño', min: 12, max: 24, step: 1, unit: 'px', default: 16 },
      { type: 'select', id: 'subtitle_weight', label: 'Peso', default: '700', options: [
        { value: '400', label: '400' }, { value: '500', label: '500' }, { value: '600', label: '600' }, { value: '700', label: '700' },
      ]},

      { type: 'header', content: 'Beneficios (checklist verde)' },
      { type: 'textarea', id: 'benefits', label: 'Beneficios', default: 'Reduce olores visibles en 2-4 semanas diarios\nMejora aliento para conversaciones cercanas\nMinimiza olor de pies tras jornadas largas\nAumenta seguridad social en eventos laborales', info: 'Una línea por beneficio.' },
      { type: 'color', id: 'benefit_color', label: 'Color del texto', default: '#111111' },
      { type: 'range', id: 'benefit_size', label: 'Tamaño', min: 12, max: 20, step: 1, unit: 'px', default: 15 },
      { type: 'color', id: 'check_color', label: 'Color del check', default: '#22C55E' },
      { type: 'range', id: 'check_size', label: 'Tamaño del check', min: 12, max: 28, step: 1, unit: 'px', default: 18 },

      { type: 'header', content: 'Precio' },
      { type: 'checkbox', id: 'show_price', label: 'Mostrar precio', default: true },
      { type: 'checkbox', id: 'use_product_price', label: 'Usar precio del producto de Shopify', default: false },
      { type: 'text', id: 'price_current', label: 'Precio actual', default: '$24.990' },
      { type: 'text', id: 'price_original', label: 'Precio original (tachado, opcional)', default: '$31.990' },
      { type: 'color', id: 'price_color', label: 'Color precio actual', default: '#000000' },
      { type: 'range', id: 'price_size', label: 'Tamaño precio actual', min: 14, max: 36, step: 1, unit: 'px', default: 22 },
      { type: 'color', id: 'price_orig_color', label: 'Color precio original', default: '#9CA3AF' },
      { type: 'range', id: 'price_orig_size', label: 'Tamaño precio original', min: 10, max: 28, step: 1, unit: 'px', default: 16 },

      // CTA: usamos exactamente los mismos IDs de ctaCommonSchemaSettings así reusamos los helpers Liquid
      ...ctaCommonSchemaSettings(),

      { type: 'header', content: 'Botón sticky al hacer scroll' },
      { type: 'checkbox', id: 'show_cart_icon', label: 'Mostrar icono de carrito al inicio del botón', default: true },
      { type: 'checkbox', id: 'sticky_on_scroll', label: 'Mantener el botón flotando al hacer scroll', default: true, info: 'Cuando el visitante baja y el botón original sale de pantalla, aparece un botón flotante en la parte inferior.' },
      { type: 'color', id: 'sticky_bg', label: 'Fondo de la barra sticky', default: '#FFFFFF' },
      { type: 'checkbox', id: 'sticky_shadow', label: 'Sombra en la barra sticky', default: true },

      { type: 'header', content: 'Trust badges (3 columnas)' },
      { type: 'checkbox', id: 'show_badges', label: 'Mostrar badges', default: true },
      { type: 'select', id: 'badge_1_icon', label: 'Icono 1', default: 'truck', options: iconOptions },
      { type: 'text',   id: 'badge_1_label', label: 'Texto 1', default: 'Envío Gratis Express' },
      { type: 'select', id: 'badge_2_icon', label: 'Icono 2', default: 'dollar', options: iconOptions },
      { type: 'text',   id: 'badge_2_label', label: 'Texto 2', default: 'Pago al Recibir' },
      { type: 'select', id: 'badge_3_icon', label: 'Icono 3', default: 'package', options: iconOptions },
      { type: 'text',   id: 'badge_3_label', label: 'Texto 3', default: 'Entregas en 2 a 5 días' },
      { type: 'color',  id: 'badge_icon_color', label: 'Color de los iconos', default: '#111111' },
      { type: 'range',  id: 'badge_icon_size',  label: 'Tamaño icono', min: 16, max: 48, step: 1, unit: 'px', default: 28 },
      { type: 'color',  id: 'badge_label_color', label: 'Color del texto', default: '#444444' },
      { type: 'range',  id: 'badge_label_size', label: 'Tamaño del texto', min: 9, max: 16, step: 1, unit: 'px', default: 12 },

      { type: 'header', content: 'Testimonio' },
      { type: 'checkbox', id: 'show_testimonial', label: 'Mostrar testimonio', default: true },
      { type: 'text', id: 't_name', label: 'Nombre', default: 'Luis Q.' },
      { type: 'range', id: 't_rating', label: 'Estrellas', min: 0, max: 5, step: 1, default: 5 },
      { type: 'textarea', id: 't_text', label: 'Texto del testimonio', default: 'Me devolvió la confianza en reuniones y citas; ya no me preocupa el olor en axilas, pies o al hablar. Se siente como un soporte natural que mejora mi seguridad social y apariencia sin químicos agresivos, lo uso a diario y noto la diferencia en cómo me miran y trato.' },
      { type: 'text', id: 't_avatar_url', label: 'URL de la foto (HTTPS, opcional)', info: 'Si está vacío, se usan las iniciales del nombre.' },
      { type: 'color', id: 't_card_bg', label: 'Fondo de la tarjeta', default: '#FFFFFF' },
      { type: 'color', id: 't_card_border', label: 'Borde de la tarjeta', default: '#E5E7EB' },
      { type: 'range', id: 't_card_radius', label: 'Radio', min: 0, max: 32, step: 1, unit: 'px', default: 12 },
      { type: 'range', id: 't_card_padding', label: 'Padding', min: 8, max: 28, step: 1, unit: 'px', default: 16 },
      { type: 'range', id: 't_avatar_size', label: 'Tamaño del avatar', min: 32, max: 80, step: 2, unit: 'px', default: 56 },
      { type: 'color', id: 't_avatar_bg', label: 'Fondo del avatar (iniciales)', default: '#F59E0B' },
      { type: 'color', id: 't_avatar_color', label: 'Color texto avatar', default: '#FFFFFF' },
      { type: 'color', id: 't_name_color', label: 'Color del nombre', default: '#111111' },
      { type: 'range', id: 't_name_size', label: 'Tamaño nombre', min: 11, max: 20, step: 1, unit: 'px', default: 14 },
      { type: 'color', id: 't_text_color', label: 'Color del texto', default: '#444444' },
      { type: 'range', id: 't_text_size', label: 'Tamaño del texto', min: 11, max: 18, step: 1, unit: 'px', default: 13 },
      { type: 'color', id: 't_star_color', label: 'Color estrellas testimonio', default: '#F59E0B' },
      { type: 'range', id: 't_star_size', label: 'Tamaño estrellas testimonio', min: 10, max: 22, step: 1, unit: 'px', default: 14 },

      { type: 'header', content: 'Espacios entre componentes' },
      { type: 'range', id: 'gap_after_rating',   label: 'Espacio después del rating',   min: 0, max: 60, step: 1, unit: 'px', default: 10 },
      { type: 'range', id: 'gap_after_title',    label: 'Espacio después del título',   min: 0, max: 60, step: 1, unit: 'px', default: 10 },
      { type: 'range', id: 'gap_after_subtitle', label: 'Espacio después del subtítulo',min: 0, max: 60, step: 1, unit: 'px', default: 16 },
      { type: 'range', id: 'gap_benefit_items',  label: 'Espacio entre beneficios',     min: 0, max: 40, step: 1, unit: 'px', default: 8 },
      { type: 'range', id: 'gap_after_benefits', label: 'Espacio después de beneficios',min: 0, max: 60, step: 1, unit: 'px', default: 18 },
      { type: 'range', id: 'gap_after_price',    label: 'Espacio después del precio',   min: 0, max: 60, step: 1, unit: 'px', default: 16 },
      { type: 'range', id: 'gap_after_cta',      label: 'Espacio después del CTA',      min: 0, max: 60, step: 1, unit: 'px', default: 16 },
      { type: 'range', id: 'gap_after_badges',   label: 'Espacio después de badges',    min: 0, max: 60, step: 1, unit: 'px', default: 16 },

      { type: 'header', content: 'Sección' },
      { type: 'color', id: 'section_bg', label: 'Color de fondo', default: '#FFFFFF' },
      { type: 'range', id: 'max_width',  label: 'Ancho máximo', min: 300, max: 1600, step: 20, unit: 'px', default: 1200 },
      { type: 'range', id: 'pad_top',    label: 'Padding superior', min: 0, max: 80, step: 2, unit: 'px', default: 24 },
      { type: 'range', id: 'pad_bottom', label: 'Padding inferior', min: 0, max: 80, step: 2, unit: 'px', default: 24 },
      { type: 'range', id: 'pad_x',      label: 'Padding lateral',  min: 0, max: 60, step: 2, unit: 'px', default: 20 },
    ],
    presets: [{ name: 'Hero de Producto' }],
  };

  const iconCases = ICON_KEYS.map(k => `        {%- when '${k}' -%}${ICON_SET[k]}`).join('\n');

  const starFilled = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15 8.5 22 9.3 17 14 18 21 12 17.8 6 21 7 14 2 9.3 9 8.5 12 2"/></svg>';
  const checkSvg   = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const cartSvg    = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>';

  const formIdLiquid = `ecom-studio-product-hero-form-{{ section.id }}`;
  // Re-rendered button used both inline and sticky. The Liquid uses `btn_style` variable
  // computed in ctaButtonInternalLiquid, so we render it twice with explicit wrappers.
  const renderButton = (extraStyle = '', includeCart = true) => `
  {%- assign _btn_style_phr = btn_style -%}
  ${extraStyle ? `{%- assign _btn_style_phr = _btn_style_phr | append: ';${extraStyle}' -%}` : ''}
  {%- if s.action_type == 'custom_url' -%}
    <a href="{% if s.custom_url != blank %}{{ s.custom_url | escape }}{% else %}#{% endif %}" target="_blank" rel="noopener" style="{{ _btn_style_phr }};display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none">${includeCart ? `{%- if s.show_cart_icon -%}<span style="display:inline-flex;width:1.2em;height:1.2em;line-height:0;flex-shrink:0">${cartSvg}</span>{%- endif -%}` : ''}<span>{{ s.text | escape }}</span></a>
  {%- elsif s.action_type == 'releaseit' -%}
    <button type="button" data-action="releasit_cod" data-variant-id="{{ product.selected_or_first_available_variant.id }}" style="{{ _btn_style_phr }};display:inline-flex;align-items:center;justify-content:center;gap:8px">${includeCart ? `{%- if s.show_cart_icon -%}<span style="display:inline-flex;width:1.2em;height:1.2em;line-height:0;flex-shrink:0">${cartSvg}</span>{%- endif -%}` : ''}<span>{{ s.text | escape }}</span></button>
  {%- elsif s.action_type == 'shopify_addtocart' -%}
    <button type="submit" form="${formIdLiquid}" style="{{ _btn_style_phr }};display:inline-flex;align-items:center;justify-content:center;gap:8px">${includeCart ? `{%- if s.show_cart_icon -%}<span style="display:inline-flex;width:1.2em;height:1.2em;line-height:0;flex-shrink:0">${cartSvg}</span>{%- endif -%}` : ''}<span>{{ s.text | escape }}</span></button>
  {%- else -%}
    <button type="submit" form="${formIdLiquid}" data-ecom-checkout="1" style="{{ _btn_style_phr }};display:inline-flex;align-items:center;justify-content:center;gap:8px">${includeCart ? `{%- if s.show_cart_icon -%}<span style="display:inline-flex;width:1.2em;height:1.2em;line-height:0;flex-shrink:0">${cartSvg}</span>{%- endif -%}` : ''}<span>{{ s.text | escape }}</span></button>
  {%- endif -%}
`;

  return `{%- comment -%} Ecom Studio AI — Hero de Producto {%- endcomment -%}
{%- assign s = section.settings -%}
${ctaButtonInternalLiquid(formIdLiquid)}
{%- if s.use_product_name -%}
  {%- assign hero_title = product.title | default: s.title_manual -%}
{%- else -%}
  {%- assign hero_title = s.title_manual -%}
{%- endif -%}
{%- if s.use_product_price -%}
  {%- assign hero_price_current = product.price | money -%}
  {%- assign hero_price_original = product.compare_at_price | money -%}
{%- else -%}
  {%- assign hero_price_current = s.price_current -%}
  {%- assign hero_price_original = s.price_original -%}
{%- endif -%}
{%- assign name_parts = s.t_name | strip | split: ' ' -%}
{%- assign first_letter = name_parts[0] | slice: 0, 1 | upcase -%}
{%- assign last_letter = name_parts.last | slice: 0, 1 | upcase -%}
{%- if name_parts.size > 1 -%}{%- assign t_initials = first_letter | append: last_letter -%}
{%- else -%}{%- assign t_initials = first_letter -%}{%- endif -%}
<section class="ecom-studio-product-hero" id="ecom-studio-product-hero-{{ section.id }}" style="display:block;background:{{ s.section_bg }};padding:{{ s.pad_top }}px {{ s.pad_x }}px {{ s.pad_bottom }}px">
  <div style="max-width:{{ s.max_width }}px;margin:0 auto;width:100%;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif">

    {%- if s.show_rating -%}
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:{{ s.gap_after_rating }}px">
        <div style="display:inline-flex;gap:1px;color:{{ s.star_color }}">
          {%- for i in (1..5) -%}
            <span style="display:inline-block;width:{{ s.star_size }}px;height:{{ s.star_size }}px;line-height:0;{% if i > s.rating %}opacity:0.25{% endif %}">${starFilled}</span>
          {%- endfor -%}
        </div>
        {%- assign review_text = s.review_format | replace: '{count}', s.review_count -%}
        <span style="color:#444;font-size:{{ s.star_size | minus: 2 }}px">{{ review_text }}</span>
      </div>
    {%- endif -%}

    {%- if hero_title != blank -%}
      <h1 style="color:{{ s.title_color }};font-size:{{ s.title_size }}px;font-weight:{{ s.title_weight }};line-height:1.15;margin:0 0 {{ s.gap_after_title }}px">{{ hero_title }}</h1>
    {%- endif -%}

    {%- if s.subtitle != blank -%}
      <p style="color:{{ s.subtitle_color }};font-size:{{ s.subtitle_size }}px;font-weight:{{ s.subtitle_weight }};line-height:1.4;margin:0 0 {{ s.gap_after_subtitle }}px">{{ s.subtitle | newline_to_br }}</p>
    {%- endif -%}

    {%- if s.benefits != blank -%}
      <ul style="list-style:none;padding:0;margin:0 0 {{ s.gap_after_benefits }}px">
        {%- assign benefit_lines = s.benefits | strip | newline_to_br | split: '<br />' -%}
        {%- for line in benefit_lines -%}
          {%- assign b = line | strip -%}
          {%- if b != blank -%}
            <li style="display:flex;align-items:flex-start;gap:10px;margin:0 0 {{ s.gap_benefit_items }}px;color:{{ s.benefit_color }};font-size:{{ s.benefit_size }}px;line-height:1.45">
              <span style="display:inline-flex;width:{{ s.check_size }}px;height:{{ s.check_size }}px;line-height:0;flex-shrink:0;color:{{ s.check_color }};margin-top:2px">${checkSvg}</span>
              <span>{{ b }}</span>
            </li>
          {%- endif -%}
        {%- endfor -%}
      </ul>
    {%- endif -%}

    {%- if s.show_price -%}
      <div style="display:flex;align-items:baseline;gap:10px;margin:0 0 {{ s.gap_after_price }}px">
        <span style="color:{{ s.price_color }};font-size:{{ s.price_size }}px;font-weight:800">{{ hero_price_current }}</span>
        {%- if hero_price_original != blank -%}
          <span style="color:{{ s.price_orig_color }};font-size:{{ s.price_orig_size }}px;text-decoration:line-through">{{ hero_price_original }}</span>
        {%- endif -%}
      </div>
    {%- endif -%}

    <div data-phr-cta-inline style="margin:0 0 {{ s.gap_after_cta }}px">
      ${renderButton('', true)}
    </div>

    {%- if s.show_badges -%}
      <div style="border-top:1px solid #E5E7EB;border-bottom:1px solid #E5E7EB;padding:14px 0;margin:0 0 {{ s.gap_after_badges }}px">
        <div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:12px;text-align:center">
          {%- assign badges_icons = s.badge_1_icon | append: ',' | append: s.badge_2_icon | append: ',' | append: s.badge_3_icon | split: ',' -%}
          {%- assign badges_labels = s.badge_1_label | append: '|' | append: s.badge_2_label | append: '|' | append: s.badge_3_label | split: '|' -%}
          {%- for ico in badges_icons -%}
            {%- capture badge_inner -%}
              {%- case ico -%}
${iconCases}
                {%- else -%}${ICON_SET.check}
              {%- endcase -%}
            {%- endcapture -%}
            <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
              <span style="display:inline-flex;width:{{ s.badge_icon_size }}px;height:{{ s.badge_icon_size }}px;color:{{ s.badge_icon_color }};line-height:0">
                <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{{ badge_inner }}</svg>
              </span>
              <span style="color:{{ s.badge_label_color }};font-size:{{ s.badge_label_size }}px;line-height:1.3">{{ badges_labels[forloop.index0] | strip }}</span>
            </div>
          {%- endfor -%}
        </div>
      </div>
    {%- endif -%}

    {%- if s.show_testimonial and s.t_text != blank -%}
      <article style="background:{{ s.t_card_bg }};border:1px solid {{ s.t_card_border }};border-radius:{{ s.t_card_radius }}px;padding:{{ s.t_card_padding }}px;display:flex;gap:12px;align-items:flex-start">
        {%- if s.t_avatar_url != blank -%}
          <img src="{{ s.t_avatar_url }}" alt="{{ s.t_name | escape }}" loading="lazy" style="width:{{ s.t_avatar_size }}px;height:{{ s.t_avatar_size }}px;border-radius:999px;object-fit:cover;flex-shrink:0">
        {%- else -%}
          <div style="width:{{ s.t_avatar_size }}px;height:{{ s.t_avatar_size }}px;border-radius:999px;background:{{ s.t_avatar_bg }};color:{{ s.t_avatar_color }};display:inline-flex;align-items:center;justify-content:center;font-size:{{ s.t_avatar_size | times: 0.4 | round }}px;font-weight:700;line-height:1;flex-shrink:0">{{ t_initials }}</div>
        {%- endif -%}
        <div style="flex:1;min-width:0">
          {%- if s.t_rating > 0 -%}
            <div style="display:inline-flex;gap:1px;color:{{ s.t_star_color }};margin-bottom:4px">
              {%- for i in (1..5) -%}
                <span style="display:inline-block;width:{{ s.t_star_size }}px;height:{{ s.t_star_size }}px;line-height:0;{% if i > s.t_rating %}opacity:0.25{% endif %}">${starFilled}</span>
              {%- endfor -%}
            </div>
          {%- endif -%}
          <p style="color:{{ s.t_text_color }};font-size:{{ s.t_text_size }}px;line-height:1.5;margin:0 0 6px">{{ s.t_text | newline_to_br }}</p>
          <div style="display:flex;align-items:center;gap:6px">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#3B82F6"><path d="M9 12l2 2 4-4M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" fill="none" stroke="#3B82F6" stroke-width="2"/></svg>
            <span style="color:{{ s.t_name_color }};font-size:{{ s.t_name_size }}px;font-weight:700">{{ s.t_name | escape }}</span>
          </div>
        </div>
      </article>
    {%- endif -%}

  </div>
</section>

{%- if s.sticky_on_scroll -%}
  <div data-phr-cta-sticky id="ecom-studio-phr-sticky-{{ section.id }}"
       style="position:fixed;left:0;right:0;bottom:0;padding:12px 16px;background:{{ s.sticky_bg }};{% if s.sticky_shadow %}box-shadow:0 -4px 12px rgba(0,0,0,.08);{% endif %}z-index:50;transform:translateY(110%);transition:transform .35s cubic-bezier(.2,.7,.2,1)">
    <div style="max-width:{{ s.max_width }}px;margin:0 auto">
      ${renderButton('', true)}
    </div>
  </div>
  <script>
  (function(){
    var inline = document.querySelector('#ecom-studio-product-hero-{{ section.id }} [data-phr-cta-inline]');
    var sticky = document.getElementById('ecom-studio-phr-sticky-{{ section.id }}');
    if (!inline || !sticky || sticky.__esPhrBound) return;
    sticky.__esPhrBound = true;
    if (!('IntersectionObserver' in window)) return;
    var observer = new IntersectionObserver(function(entries){
      var visible = entries[0].isIntersecting;
      sticky.style.transform = visible ? 'translateY(110%)' : 'translateY(0)';
    }, { threshold: 0, rootMargin: '0px 0px -40px 0px' });
    observer.observe(inline);
  })();
  </script>
{%- endif -%}

{%- if s.action_type == 'shopify_checkout' -%}
${ajaxCheckoutLiquidSnippet(formIdLiquid)}
{%- endif -%}
{%- if s.action_type == 'releaseit' -%}
${RELEASIT_BOOTSTRAP_LIQUID}
{%- endif -%}

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function statsSectionLiquid() {
  const schema = {
    name: 'Estadísticas',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      { type: 'header', content: 'Título' },
      { type: 'text', id: 'title', label: 'Título de la sección', default: 'Resultados que hablan por sí solos' },
      { type: 'checkbox', id: 'show_title', label: 'Mostrar título', default: true },
      { type: 'color', id: 'title_color', label: 'Color del título', default: '#000000' },
      { type: 'range', id: 'title_size', label: 'Tamaño del título', min: 14, max: 48, step: 1, unit: 'px', default: 28 },
      { type: 'select', id: 'title_align', label: 'Alineación', default: 'center', options: [
        { value: 'left', label: 'Izquierda' },
        { value: 'center', label: 'Centrado' },
        { value: 'right', label: 'Derecha' },
      ]},

      { type: 'header', content: 'Layout' },
      { type: 'select', id: 'layout', label: 'Disposición', default: 'grid', info: 'Grid = columnas centradas. Lista = filas con badge a la izquierda y texto a la derecha.', options: [
        { value: 'grid', label: 'Grid (columnas)' },
        { value: 'list', label: 'Lista (filas)' },
      ]},
      { type: 'range', id: 'columns', label: 'Columnas (solo Grid)', min: 2, max: 4, step: 1, default: 3 },
      { type: 'range', id: 'item_gap', label: 'Espacio entre ítems', min: 0, max: 48, step: 2, unit: 'px', default: 16 },
      { type: 'checkbox', id: 'show_dividers', label: 'Divisores entre ítems (solo Lista)', default: true },
      { type: 'color', id: 'divider_color', label: 'Color del divisor', default: '#E5E5E5' },
      { type: 'color', id: 'bg_color', label: 'Color de fondo', default: '#FFFFFF' },
      { type: 'range', id: 'max_width', label: 'Ancho máximo', min: 400, max: 1600, step: 20, unit: 'px', default: 1200 },
      { type: 'range', id: 'pad_top', label: 'Padding superior', min: 0, max: 120, step: 4, unit: 'px', default: 40 },
      { type: 'range', id: 'pad_bottom', label: 'Padding inferior', min: 0, max: 120, step: 4, unit: 'px', default: 40 },
      { type: 'range', id: 'pad_x', label: 'Padding lateral', min: 0, max: 60, step: 2, unit: 'px', default: 20 },

      { type: 'header', content: 'Badge del número (solo Lista)' },
      { type: 'select', id: 'badge_style', label: 'Estilo del badge', default: 'none', options: [
        { value: 'none',   label: 'Sin badge (solo número)' },
        { value: 'ring',   label: 'Anillo (borde)' },
        { value: 'filled', label: 'Relleno (círculo sólido)' },
      ]},
      { type: 'color', id: 'badge_color', label: 'Color del anillo / relleno', default: '#F59E0B' },
      { type: 'color', id: 'badge_bg', label: 'Color de fondo del badge', default: '#FFFFFF' },
      { type: 'range', id: 'badge_size', label: 'Tamaño', min: 40, max: 160, step: 2, unit: 'px', default: 80 },
      { type: 'range', id: 'badge_border', label: 'Grosor del anillo', min: 1, max: 12, step: 1, unit: 'px', default: 4 },

      { type: 'header', content: 'Estilo del número' },
      { type: 'color', id: 'number_color', label: 'Color', default: '#F59E0B' },
      { type: 'range', id: 'number_size', label: 'Tamaño', min: 12, max: 96, step: 1, unit: 'px', default: 22 },

      { type: 'header', content: 'Estilo de la etiqueta' },
      { type: 'color', id: 'label_color', label: 'Color', default: '#111111' },
      { type: 'range', id: 'label_size', label: 'Tamaño', min: 10, max: 24, step: 1, unit: 'px', default: 16 },

      { type: 'header', content: 'Estilo de la descripción' },
      { type: 'color', id: 'desc_color', label: 'Color', default: '#666666' },
      { type: 'range', id: 'desc_size', label: 'Tamaño', min: 9, max: 20, step: 1, unit: 'px', default: 13 },
    ],
    blocks: [
      {
        type: 'stat',
        name: 'Estadística',
        settings: [
          { type: 'text', id: 'number', label: 'Número', info: 'Ej. "98%", "+10K", "4.9★"' },
          { type: 'text', id: 'label', label: 'Etiqueta principal' },
          { type: 'textarea', id: 'desc', label: 'Descripción (opcional)' },
        ],
      },
    ],
    max_blocks: 6,
    presets: [{ name: 'Estadísticas' }],
  };
  return `{%- comment -%} Ecom Studio AI — Estadísticas {%- endcomment -%}
{%- assign s = section.settings -%}
<section class="ecom-studio-stats" style="display:block;background:{{ s.bg_color }};padding:{{ s.pad_top }}px {{ s.pad_x }}px {{ s.pad_bottom }}px">
  <div style="max-width:{{ s.max_width }}px;margin:0 auto;width:100%">
    {%- if s.show_title and s.title != blank -%}
      <h2 style="color:{{ s.title_color }};font-size:{{ s.title_size }}px;text-align:{{ s.title_align }};margin:0 0 28px;font-weight:700;line-height:1.2">{{ s.title | escape }}</h2>
    {%- endif -%}

    {%- if s.layout == 'list' -%}
      {%- comment -%} List layout: stacked rows with badge on the left, text on the right {%- endcomment -%}
      <div class="ecom-studio-stats__list" style="display:flex;flex-direction:column;gap:{{ s.item_gap }}px">
        {%- for block in section.blocks -%}
          {%- if block.settings.number != blank or block.settings.label != blank -%}
            {%- unless forloop.first -%}{%- if s.show_dividers -%}<div style="height:1px;background:{{ s.divider_color }}"></div>{%- endif -%}{%- endunless -%}
            <div {{ block.shopify_attributes }} class="ecom-studio-stats__row" style="display:flex;align-items:center;gap:24px">
              {%- if block.settings.number != blank -%}
                {%- if s.badge_style == 'ring' -%}
                  <div style="flex-shrink:0;width:{{ s.badge_size }}px;height:{{ s.badge_size }}px;border-radius:50%;background:{{ s.badge_bg }};border:{{ s.badge_border }}px solid {{ s.badge_color }};display:flex;align-items:center;justify-content:center;color:{{ s.number_color }};font-size:{{ s.number_size }}px;font-weight:800;line-height:1">{{ block.settings.number | escape }}</div>
                {%- elsif s.badge_style == 'filled' -%}
                  <div style="flex-shrink:0;width:{{ s.badge_size }}px;height:{{ s.badge_size }}px;border-radius:50%;background:{{ s.badge_color }};display:flex;align-items:center;justify-content:center;color:{{ s.number_color }};font-size:{{ s.number_size }}px;font-weight:800;line-height:1">{{ block.settings.number | escape }}</div>
                {%- else -%}
                  <div style="flex-shrink:0;min-width:{{ s.badge_size }}px;text-align:center;color:{{ s.number_color }};font-size:{{ s.number_size }}px;font-weight:800;line-height:1">{{ block.settings.number | escape }}</div>
                {%- endif -%}
              {%- endif -%}
              <div style="flex:1;min-width:0">
                {%- if block.settings.label != blank -%}
                  <div style="color:{{ s.label_color }};font-size:{{ s.label_size }}px;font-weight:600;line-height:1.4">{{ block.settings.label | escape }}</div>
                {%- endif -%}
                {%- if block.settings.desc != blank -%}
                  <div style="color:{{ s.desc_color }};font-size:{{ s.desc_size }}px;line-height:1.5;margin-top:4px">{{ block.settings.desc | newline_to_br }}</div>
                {%- endif -%}
              </div>
            </div>
          {%- endif -%}
        {%- endfor -%}
      </div>
    {%- else -%}
      {%- comment -%} Grid layout: equal-width columns, content centered {%- endcomment -%}
      <div class="ecom-studio-stats__grid" style="display:grid;grid-template-columns:repeat({{ s.columns }}, 1fr);gap:{{ s.item_gap }}px">
        {%- for block in section.blocks -%}
          {%- if block.settings.number != blank or block.settings.label != blank -%}
            <div {{ block.shopify_attributes }} class="ecom-studio-stats__item" style="text-align:center">
              {%- if block.settings.number != blank -%}
                <div style="color:{{ s.number_color }};font-size:{{ s.number_size }}px;font-weight:800;line-height:1;letter-spacing:-.02em;margin-bottom:8px">{{ block.settings.number | escape }}</div>
              {%- endif -%}
              {%- if block.settings.label != blank -%}
                <div style="color:{{ s.label_color }};font-size:{{ s.label_size }}px;font-weight:600;line-height:1.3">{{ block.settings.label | escape }}</div>
              {%- endif -%}
              {%- if block.settings.desc != blank -%}
                <div style="color:{{ s.desc_color }};font-size:{{ s.desc_size }}px;font-weight:400;line-height:1.45;margin-top:4px">{{ block.settings.desc | newline_to_br }}</div>
              {%- endif -%}
            </div>
          {%- endif -%}
        {%- endfor -%}
      </div>
    {%- endif -%}
  </div>
</section>
<style>
  @media (max-width: 640px) {
    .ecom-studio-stats__grid { grid-template-columns: 1fr 1fr !important; }
  }
</style>

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function faqSectionLiquid() {
  const schema = {
    name: 'Preguntas Frecuentes',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      { type: 'header', content: 'Título' },
      { type: 'text', id: 'title', label: 'Título de la sección', default: 'Preguntas Frecuentes' },
      { type: 'checkbox', id: 'show_title', label: 'Mostrar título', default: true },
      { type: 'color', id: 'title_color', label: 'Color del título', default: '#000000' },
      { type: 'range', id: 'title_size', label: 'Tamaño del título', min: 14, max: 48, step: 1, unit: 'px', default: 28 },
      { type: 'select', id: 'title_align', label: 'Alineación', default: 'center', options: [
        { value: 'left', label: 'Izquierda' },
        { value: 'center', label: 'Centrado' },
        { value: 'right', label: 'Derecha' },
      ]},

      { type: 'header', content: 'Estilo de los ítems' },
      { type: 'color', id: 'item_bg', label: 'Fondo del ítem', default: '#F8F8F8' },
      { type: 'color', id: 'item_border_color', label: 'Color del borde', default: '#E5E5E5' },
      { type: 'color', id: 'item_question_color', label: 'Color de la pregunta', default: '#000000' },
      { type: 'color', id: 'item_text_color', label: 'Color de la respuesta', default: '#111111' },
      { type: 'range', id: 'item_border_radius', label: 'Radio', min: 0, max: 30, step: 1, unit: 'px', default: 8 },
      { type: 'range', id: 'item_gap', label: 'Espacio entre ítems', min: 0, max: 32, step: 1, unit: 'px', default: 8 },
      { type: 'range', id: 'item_padding', label: 'Padding interno', min: 8, max: 36, step: 1, unit: 'px', default: 16 },

      { type: 'header', content: 'Layout' },
      { type: 'color', id: 'bg_color', label: 'Color de fondo de la sección', default: '#FFFFFF' },
      { type: 'range', id: 'max_width', label: 'Ancho máximo', min: 400, max: 1600, step: 20, unit: 'px', default: 880 },
      { type: 'range', id: 'pad_top', label: 'Padding superior', min: 0, max: 120, step: 4, unit: 'px', default: 40 },
      { type: 'range', id: 'pad_bottom', label: 'Padding inferior', min: 0, max: 120, step: 4, unit: 'px', default: 40 },
      { type: 'range', id: 'pad_x', label: 'Padding lateral', min: 0, max: 60, step: 2, unit: 'px', default: 20 },
    ],
    blocks: [
      {
        type: 'faq_item',
        name: 'Pregunta',
        settings: [
          { type: 'text', id: 'q', label: 'Pregunta' },
          { type: 'textarea', id: 'a', label: 'Respuesta' },
        ],
      },
    ],
    max_blocks: 30,
    presets: [{ name: 'Preguntas Frecuentes' }],
  };
  return `{%- comment -%} Ecom Studio AI — Preguntas Frecuentes {%- endcomment -%}
{%- assign s = section.settings -%}
<section class="ecom-studio-faq" style="display:block;background:{{ s.bg_color }};padding:{{ s.pad_top }}px {{ s.pad_x }}px {{ s.pad_bottom }}px">
  <div style="max-width:{{ s.max_width }}px;margin:0 auto;width:100%">
    {%- if s.show_title and s.title != blank -%}
      <h2 style="color:{{ s.title_color }};font-size:{{ s.title_size }}px;text-align:{{ s.title_align }};margin:0 0 24px;font-weight:700;line-height:1.2">{{ s.title | escape }}</h2>
    {%- endif -%}
    <div style="display:flex;flex-direction:column;gap:{{ s.item_gap }}px">
      {%- for block in section.blocks -%}
        {%- if block.settings.q != blank -%}
          <details {{ block.shopify_attributes }} class="ecom-studio-faq__item" style="background:{{ s.item_bg }};border:1px solid {{ s.item_border_color }};border-radius:{{ s.item_border_radius }}px;overflow:hidden">
            <summary style="list-style:none;padding:{{ s.item_padding }}px;cursor:pointer;display:flex;align-items:center;gap:12px;color:{{ s.item_question_color }};font-weight:600;font-size:15px;line-height:1.4">
              <span style="flex:1">{{ block.settings.q | escape }}</span>
              <span class="ecom-studio-faq__icon" style="flex-shrink:0;transition:transform .2s;font-size:18px;line-height:1;color:{{ s.item_question_color }}">+</span>
            </summary>
            {%- if block.settings.a != blank -%}
              <div style="padding:0 {{ s.item_padding }}px {{ s.item_padding }}px;color:{{ s.item_text_color }};font-size:14px;line-height:1.6">{{ block.settings.a | newline_to_br }}</div>
            {%- endif -%}
          </details>
        {%- endif -%}
      {%- endfor -%}
    </div>
  </div>
</section>
<style>
  .ecom-studio-faq details > summary::-webkit-details-marker { display:none; }
  .ecom-studio-faq details[open] .ecom-studio-faq__icon { transform:rotate(45deg); }
</style>

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function ctaCommonSchemaSettings() {
  const fontOptions = [
    { value: 'system-ui',  label: 'System UI' },
    { value: 'Inter',      label: 'Inter' },
    { value: 'Roboto',     label: 'Roboto' },
    { value: 'Poppins',    label: 'Poppins' },
    { value: 'Montserrat', label: 'Montserrat' },
    { value: 'Arial',      label: 'Arial' },
    { value: 'Georgia',    label: 'Georgia' },
  ];
  return [
    { type: 'header', content: '¿Qué pasa al hacer click?' },
    { type: 'select', id: 'action_type', label: 'Acción', default: 'shopify_checkout', options: [
      { value: 'shopify_checkout',  label: 'Iniciar checkout de Shopify' },
      { value: 'shopify_addtocart', label: 'Agregar al carrito' },
      { value: 'releaseit',         label: 'Abrir formulario Releasit (COD)' },
      { value: 'custom_url',        label: 'URL personalizada' },
    ]},
    { type: 'text', id: 'custom_url', label: 'URL personalizada', info: 'Solo se usa si la acción es URL personalizada.' },

    { type: 'header', content: 'Botón principal' },
    { type: 'text', id: 'text', label: 'Texto del botón', default: 'COMPRAR AHORA' },
    { type: 'color', id: 'bg_color', label: 'Color de fondo', default: '#000000' },
    { type: 'color', id: 'text_color', label: 'Color del texto', default: '#FFFFFF' },
    { type: 'select', id: 'font_family', label: 'Tipografía', default: 'system-ui', options: fontOptions },
    { type: 'select', id: 'text_style', label: 'Estilo del texto', default: 'uppercase', options: [
      { value: 'uppercase', label: 'MAYÚSCULAS' },
      { value: 'normal',    label: 'Normal' },
      { value: 'lowercase', label: 'minúsculas' },
    ]},
    { type: 'checkbox', id: 'bold', label: 'Texto en negrita', default: true },
    { type: 'range', id: 'font_size',      label: 'Tamaño texto',    min: 8, max: 32, step: 1, unit: 'px', default: 16 },
    { type: 'range', id: 'letter_spacing', label: 'Espaciado letras',min: 0, max: 5,  step: 0.1, unit: 'px', default: 0.5 },
    { type: 'range', id: 'btn_pad_y',      label: 'Alto (padding vertical)', min: 0, max: 50, step: 1, unit: 'px', default: 15 },
    { type: 'range', id: 'border_radius',  label: 'Radio', min: 0, max: 60, step: 1, unit: 'px', default: 10 },

    { type: 'header', content: 'Logo superior (opcional)' },
    { type: 'text', id: 'logo_top_url', label: 'URL del logo superior (HTTPS)' },

    { type: 'header', content: 'Logo inferior (opcional)' },
    { type: 'text', id: 'logo_bottom_url', label: 'URL del logo inferior (HTTPS)' },
  ];
}

// Liquid snippet used inside CTA + Float-CTA that emits the button + form + scripts.
// `barIdLiquid` is the Liquid expression for the unique bar element id (e.g. "'ecom-studio-cta-' | append: section.id").
function ctaButtonInternalLiquid(formIdLiquid) {
  return `
{%- case s.font_family -%}
  {%- when 'system-ui' -%}{%- assign ff = '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif' -%}
  {%- else -%}{%- assign ff = s.font_family -%}
{%- endcase -%}
{%- case s.text_style -%}
  {%- when 'uppercase' -%}{%- assign tt = 'uppercase' -%}
  {%- when 'lowercase' -%}{%- assign tt = 'lowercase' -%}
  {%- else -%}{%- assign tt = 'none' -%}
{%- endcase -%}
{%- if s.bold -%}{%- assign fw = 700 -%}{%- else -%}{%- assign fw = 500 -%}{%- endif -%}
{%- assign btn_style = 'display:inline-block;width:100%;box-sizing:border-box;cursor:pointer;border:none;background:' | append: s.bg_color | append: ';color:' | append: s.text_color | append: ';font-family:' | append: ff | append: ';font-size:' | append: s.font_size | append: 'px;font-weight:' | append: fw | append: ';letter-spacing:' | append: s.letter_spacing | append: 'px;padding:' | append: s.btn_pad_y | append: 'px 16px;border-radius:' | append: s.border_radius | append: 'px;text-transform:' | append: tt | append: ';text-align:center;line-height:1.2;text-decoration:none' -%}
{%- if s.action_type == 'shopify_checkout' or s.action_type == 'shopify_addtocart' -%}
<form id="${formIdLiquid}" action="/cart/add" method="post" style="display:none">
  <input type="hidden" name="id" value="{{ product.selected_or_first_available_variant.id }}">
  <input type="hidden" name="quantity" value="1">
</form>
{%- endif -%}`;
}

function ctaButtonRenderLiquid(formIdLiquid) {
  return `
  {%- if s.logo_top_url != blank -%}
    <div style="margin-bottom:8px;line-height:0;text-align:center"><img src="{{ s.logo_top_url }}" alt="" style="max-height:28px;max-width:60%;display:inline-block"></div>
  {%- endif -%}
  {%- if s.action_type == 'custom_url' -%}
    <a href="{% if s.custom_url != blank %}{{ s.custom_url | escape }}{% else %}#{% endif %}" target="_blank" rel="noopener" style="{{ btn_style }}">{{ s.text | escape }}</a>
  {%- elsif s.action_type == 'releaseit' -%}
    <button type="button" data-action="releasit_cod" data-variant-id="{{ product.selected_or_first_available_variant.id }}" style="{{ btn_style }}">{{ s.text | escape }}</button>
  {%- elsif s.action_type == 'shopify_addtocart' -%}
    <button type="submit" form="${formIdLiquid}" style="{{ btn_style }}">{{ s.text | escape }}</button>
  {%- else -%}
    <button type="submit" form="${formIdLiquid}" data-ecom-checkout="1" style="{{ btn_style }}">{{ s.text | escape }}</button>
  {%- endif -%}
  {%- if s.logo_bottom_url != blank -%}
    <div style="margin-top:8px;line-height:0;text-align:center"><img src="{{ s.logo_bottom_url }}" alt="" style="max-height:22px;max-width:55%;display:inline-block"></div>
  {%- endif -%}`;
}

function ctaSectionLiquid() {
  const schema = {
    name: 'Botón CTA',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      ...ctaCommonSchemaSettings(),
      { type: 'header', content: 'Diseño y espaciado' },
      { type: 'range', id: 'max_width',  label: 'Ancho máximo', min: 200, max: 1600, step: 20, unit: 'px', default: 1200 },
      { type: 'range', id: 'pad_top',    label: 'Padding superior', min: 0, max: 60, step: 1, unit: 'px', default: 10 },
      { type: 'range', id: 'pad_bottom', label: 'Padding inferior', min: 0, max: 60, step: 1, unit: 'px', default: 10 },
      { type: 'range', id: 'pad_x',      label: 'Padding lateral',  min: 0, max: 60, step: 1, unit: 'px', default: 20 },
      { type: 'color', id: 'bar_bg_color', label: 'Color de fondo de la barra', default: '#FFFFFF' },
      { type: 'checkbox', id: 'use_gradient', label: 'Usar degradado de fondo', info: 'La barra actúa como puente visual entre la sección de arriba y la de abajo.', default: false },
      { type: 'color', id: 'bar_grad_top',    label: 'Color superior (gradiente)', default: '#000000' },
      { type: 'color', id: 'bar_grad_bottom', label: 'Color inferior (gradiente)', default: '#FFFFFF' },
    ],
    presets: [{ name: 'Botón CTA' }],
  };
  const formIdLiquid = `ecom-studio-cta-form-{{ section.id }}`;
  return `{%- comment -%} Ecom Studio AI — Botón CTA {%- endcomment -%}
{%- assign s = section.settings -%}
{%- if s.use_gradient -%}
  {%- assign bg = 'linear-gradient(180deg, ' | append: s.bar_grad_top | append: ', ' | append: s.bar_grad_bottom | append: ')' -%}
{%- else -%}
  {%- assign bg = s.bar_bg_color -%}
{%- endif -%}
${ctaButtonInternalLiquid(formIdLiquid)}
<div class="ecom-studio-cta" style="display:block;background:{{ bg }};padding:{{ s.pad_top }}px {{ s.pad_x }}px {{ s.pad_bottom }}px">
  <div style="max-width:{{ s.max_width }}px;margin:0 auto;width:100%;text-align:center;line-height:0">
${ctaButtonRenderLiquid(formIdLiquid)}
  </div>
</div>
{%- if s.action_type == 'shopify_checkout' -%}
${ajaxCheckoutLiquidSnippet(formIdLiquid)}
{%- endif -%}
{%- if s.action_type == 'releaseit' -%}
${RELEASIT_BOOTSTRAP_LIQUID}
{%- endif -%}

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

function floatCtaSectionLiquid() {
  const schema = {
    name: 'Botón Flotante',
    tag: 'div',
    class: 'ecom-studio-section',
    settings: [
      ...ctaCommonSchemaSettings(),
      { type: 'header', content: 'Diseño y espaciado' },
      { type: 'range', id: 'scroll_threshold', label: 'Aparece al hacer scroll', min: 0, max: 2000, step: 20, unit: 'px', default: 300 },
      { type: 'range', id: 'max_width',  label: 'Ancho máximo', min: 200, max: 1600, step: 20, unit: 'px', default: 1200 },
      { type: 'range', id: 'pad_top',    label: 'Padding superior', min: 0, max: 60, step: 1, unit: 'px', default: 10 },
      { type: 'range', id: 'pad_bottom', label: 'Padding inferior', min: 0, max: 60, step: 1, unit: 'px', default: 10 },
      { type: 'range', id: 'pad_x',      label: 'Padding lateral',  min: 0, max: 60, step: 1, unit: 'px', default: 20 },
      { type: 'color', id: 'bar_bg_color', label: 'Color de fondo de la barra', default: '#FFFFFF' },
    ],
    presets: [{ name: 'Botón Flotante' }],
  };
  const formIdLiquid = `ecom-studio-float-form-{{ section.id }}`;
  const barIdLiquid  = `ecom-studio-float-{{ section.id }}`;
  return `{%- comment -%} Ecom Studio AI — Botón Flotante {%- endcomment -%}
{%- assign s = section.settings -%}
${ctaButtonInternalLiquid(formIdLiquid)}
<div id="${barIdLiquid}" class="ecom-studio-float-cta" style="position:fixed;left:0;right:0;bottom:0;z-index:90;display:none;background:{{ s.bar_bg_color }};padding:{{ s.pad_top }}px {{ s.pad_x }}px {{ s.pad_bottom }}px;box-shadow:0 -4px 16px rgba(0,0,0,.08)">
  <div style="max-width:{{ s.max_width }}px;margin:0 auto;width:100%;text-align:center;line-height:0">
${ctaButtonRenderLiquid(formIdLiquid)}
  </div>
</div>
<script>
(function(){
  var el = document.getElementById('${barIdLiquid}');
  if (!el) return;
  var threshold = {{ s.scroll_threshold | default: 300 }};
  function check(){ el.style.display = (window.scrollY > threshold) ? 'block' : 'none'; }
  window.addEventListener('scroll', check, { passive:true });
  window.addEventListener('resize', check);
  check();
})();
</script>
{%- if s.action_type == 'shopify_checkout' -%}
${ajaxCheckoutLiquidSnippet(formIdLiquid)}
{%- endif -%}
{%- if s.action_type == 'releaseit' -%}
${RELEASIT_BOOTSTRAP_LIQUID}
{%- endif -%}

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`;
}

// ─────────────────────────────────────────────────────────────────
// Template JSON builder
// ─────────────────────────────────────────────────────────────────

/**
 * Build the JSON template for an assembled landing.
 *
 * Returns { templateJson, sectionFiles }:
 *   - templateJson: string, contents of templates/product.<suffix>.json
 *   - sectionFiles: { sectionKey → liquid string }, the section files to install
 *
 * Walk order in the JSON template:
 *   1. global-top elements (announcement bar)
 *   2. For each image slot:
 *      a. inline elements with position before-section + section_id == this slot
 *      b. the image section
 *      c. inline elements with position after-section + section_id == this slot
 *   3. global-bottom elements (floating CTA)
 */
// ─────────────────────────────────────────────────────────────────
// Schema-driven settings sanitizer
// Snaps range-typed setting values to a valid step-multiple, so saved
// configs from older versions don't get rejected by Shopify when the
// schema's `step` changes. Schemas are parsed once and cached per def.
// ─────────────────────────────────────────────────────────────────
const _schemaCache = new Map();
function getSchemaFor(def) {
  if (!def || !def.liquid) return null;
  if (_schemaCache.has(def.sectionKey)) return _schemaCache.get(def.sectionKey);
  let schema = null;
  try {
    const src = def.liquid();
    const m = src.match(/\{% schema %\}\n([\s\S]+?)\n\{% endschema %\}/);
    if (m) schema = JSON.parse(m[1]);
  } catch (_) {}
  _schemaCache.set(def.sectionKey, schema);
  return schema;
}
function snapValueToRange(rule, v) {
  let n = Number(v);
  if (!Number.isFinite(n)) n = rule.default;
  if (n < rule.min) n = rule.min;
  if (n > rule.max) n = rule.max;
  if (rule.step && rule.step !== 1) {
    const steps = Math.round((n - rule.min) / rule.step);
    n = rule.min + steps * rule.step;
    // Re-clamp in case step push went past bounds
    if (n < rule.min) n = rule.min;
    if (n > rule.max) n = rule.max;
  }
  return n;
}
function sanitizeAgainstSchema(settings, schemaSettings) {
  if (!settings || !Array.isArray(schemaSettings)) return settings;
  for (const rule of schemaSettings) {
    if (rule.type !== 'range') continue;
    if (!(rule.id in settings)) continue;
    settings[rule.id] = snapValueToRange(rule, settings[rule.id]);
  }
  return settings;
}

function buildAssembledTemplate({ assembled, uploadedSrcs, uploadedSectionIds, elementsRemapped, safeTitle }) {
  const sections = {};
  const order = [];
  let counter = 0;
  const nextId = (prefix) => `${prefix}_${++counter}`;

  // Helper: build a section entry, including blocks when the element type has them.
  // Always sanitizes against the schema so old/invalid range values get snapped.
  const sectionEntryFor = (def, elem) => {
    const cfg = elem.config || {};
    const entry = { type: def.sectionKey, settings: def.settings(cfg) };
    const schema = getSchemaFor(def);
    if (schema) {
      sanitizeAgainstSchema(entry.settings, schema.settings);
    }
    if (def.hasBlocks && typeof def.buildBlocks === 'function') {
      const { blocks, block_order } = def.buildBlocks(cfg);
      entry.blocks = blocks || {};
      entry.block_order = block_order || [];
      // Sanitize each block's settings against its schema block-type
      if (schema && Array.isArray(schema.blocks)) {
        for (const blkId of Object.keys(entry.blocks)) {
          const blk = entry.blocks[blkId];
          const blkSchema = schema.blocks.find(b => b.type === blk.type);
          if (blkSchema) sanitizeAgainstSchema(blk.settings, blkSchema.settings);
        }
      }
    }
    return entry;
  };

  // 1. Global-top
  for (const e of elementsRemapped) {
    const def = ELEMENT_DEFS[e.type];
    if (!def || def.placement !== 'global-top') continue;
    const id = nextId(def.idPrefix);
    sections[id] = sectionEntryFor(def, e);
    order.push(id);
  }

  // 2. Image slots + inline elements
  for (let i = 0; i < uploadedSrcs.length; i++) {
    const sid = uploadedSectionIds[i];
    // before this image
    for (const e of elementsRemapped) {
      const def = ELEMENT_DEFS[e.type];
      if (!def || def.placement !== 'inline') continue;
      if (e.position?.kind !== 'before-section' || e.position?.section_id !== sid) continue;
      const id = nextId(def.idPrefix);
      sections[id] = sectionEntryFor(def, e);
      order.push(id);
    }
    // the image
    const imgId = nextId(IMAGE_SECTION.idPrefix);
    sections[imgId] = {
      type: IMAGE_SECTION.sectionKey,
      settings: {
        image_url: uploadedSrcs[i],
        alt:       `${safeTitle} — sección ${i + 1}`,
        link:      '',
        max_width: 1200,
        eager_load: i === 0,
      },
    };
    order.push(imgId);
    // after this image
    for (const e of elementsRemapped) {
      const def = ELEMENT_DEFS[e.type];
      if (!def || def.placement !== 'inline') continue;
      if (e.position?.kind !== 'after-section' || e.position?.section_id !== sid) continue;
      const id = nextId(def.idPrefix);
      sections[id] = sectionEntryFor(def, e);
      order.push(id);
    }
  }

  // 3. Global-bottom
  for (const e of elementsRemapped) {
    const def = ELEMENT_DEFS[e.type];
    if (!def || def.placement !== 'global-bottom') continue;
    const id = nextId(def.idPrefix);
    sections[id] = sectionEntryFor(def, e);
    order.push(id);
  }

  // Collect required section files: always the image section + every used element type.
  const sectionFiles = {
    [IMAGE_SECTION.sectionKey]: imageSectionLiquid(),
  };
  const seenTypes = new Set();
  for (const e of elementsRemapped) {
    if (seenTypes.has(e.type)) continue;
    const def = ELEMENT_DEFS[e.type];
    if (!def) continue;
    seenTypes.add(e.type);
    sectionFiles[def.sectionKey] = def.liquid();
  }

  return {
    templateJson: JSON.stringify({ sections, order }, null, 2),
    sectionFiles,
  };
}

module.exports = {
  ELEMENT_DEFS,
  IMAGE_SECTION,
  ICON_KEYS,
  buildAssembledTemplate,
};
