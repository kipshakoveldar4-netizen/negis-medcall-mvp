(() => {
  const form = document.querySelector('form[data-intake-endpoint]');
  if (!form) return;
  const status = document.getElementById('form-status');
  const button = form.querySelector('button');
  let token = '';
  let widget;
  let busy = false;
  let requestKey;
  let previousPayload = '';
  const setToken = value => { token = value; button.disabled = busy || !token; };
  window.medinaChallengeReady = () => {
    widget = window.turnstile.render(form.querySelector('[data-challenge]'), {
      sitekey: form.dataset.siteKey, action: 'site_inquiry', size: 'flexible',
      callback: value => setToken(value),
      'expired-callback': () => setToken(''),
      'error-callback': () => { setToken(''); status.textContent = 'Проверка защиты недоступна. Обновите страницу позже.'; },
    });
  };
  const challengeScript = document.createElement('script');
  challengeScript.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=medinaChallengeReady&render=explicit';
  challengeScript.async = true;
  challengeScript.onerror = () => { status.textContent = 'Не удалось загрузить защиту формы. Попробуйте позже.'; };
  document.head.append(challengeScript);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !token || !form.reportValidity()) return;
    const fields = new FormData(form);
    const inquiry = {
      name: fields.get('name'), phone: fields.get('phone'), business: fields.get('business'),
      service: fields.get('service'), pagePath: location.pathname,
      consentVersion: form.dataset.consentVersion, consent: fields.get('consent') === 'on',
    };
    const payload = JSON.stringify(inquiry);
    if (payload !== previousPayload || !requestKey) { requestKey = crypto.randomUUID(); previousPayload = payload; }
    busy = true;
    form.querySelector('fieldset').disabled = true;
    button.disabled = true;
    status.textContent = 'Отправляем заявку…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(form.dataset.intakeEndpoint, {
        method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
        signal: controller.signal, body: JSON.stringify({ requestKey, inquiry, challengeToken: token }),
      });
      let data = null;
      try { data = JSON.parse(await response.text()); } catch { /* Never display a raw response. */ }
      if (!response.ok || data?.success !== true) {
        const messages = {
          invalid_phone: 'Проверьте номер телефона с кодом страны.',
          consent_required: 'Подтвердите согласие на обработку контактных данных.',
          invalid_inquiry: 'Проверьте поля формы и попробуйте ещё раз.',
          challenge_failed: 'Пройдите проверку защиты повторно.',
          rate_limited: 'Слишком много попыток. Попробуйте отправить заявку позже.',
          request_conflict: 'Обновите страницу и отправьте заявку повторно.',
        };
        status.textContent = Object.hasOwn(messages, data?.code) ? messages[data.code] : 'Не удалось подтвердить отправку. Данные остались в форме; попробуйте позже.';
        return;
      }
      form.querySelector('fieldset').disabled = true;
      status.textContent = 'Заявка принята. Свяжемся с вами по указанному телефону.';
      form.dataset.sent = 'true';
    } catch {
      status.textContent = 'Не удалось подтвердить отправку. Данные остались в форме; попробуйте позже.';
    } finally {
      clearTimeout(timeout);
      busy = false;
      if (form.dataset.sent !== 'true') form.querySelector('fieldset').disabled = false;
      setToken('');
      if (form.dataset.sent !== 'true' && widget !== undefined) window.turnstile.reset(widget);
    }
  });
})();
