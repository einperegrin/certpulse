/* CertPulse landing — copy-to-clipboard for hero CTA + step blocks */
(function () {
  'use strict';

  const toast = document.getElementById('toast');
  let toastTimer = null;
  function showToast(msg) {
    if (!toast) return;
    toast.textContent = msg;
    toast.hidden = false;
    requestAnimationFrame(() => toast.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => { toast.hidden = true; }, 200);
    }, 1800);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }

  function attach(btn) {
    const text = btn.getAttribute('data-copy');
    if (!text) return;
    btn.addEventListener('click', async function () {
      const ok = await copyText(text);
      if (ok) {
        const original = btn.dataset.originalLabel || btn.textContent;
        btn.dataset.originalLabel = original;
        btn.classList.add('copied');
        const ctaText = document.getElementById('copy-cta-text');
        if (btn.id === 'copy-cta' && ctaText) {
          ctaText.textContent = 'Copied ✓';
        } else {
          btn.textContent = 'Copied ✓';
        }
        showToast('Copied to clipboard');
        setTimeout(() => {
          btn.classList.remove('copied');
          if (btn.id === 'copy-cta' && ctaText) {
            ctaText.textContent = 'Copy quick start';
          } else {
            btn.textContent = original;
          }
        }, 1500);
      } else {
        showToast('Copy failed — select and copy manually');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    const cta = document.getElementById('copy-cta');
    if (cta) attach(cta);
    document.querySelectorAll('.copy-btn[data-copy]').forEach(attach);
  });
})();
