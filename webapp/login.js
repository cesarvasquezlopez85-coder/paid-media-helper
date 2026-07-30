const form = document.getElementById('login-form');
const usernameInput = document.getElementById('login-username');
const passwordInput = document.getElementById('login-password');
const codeField = document.getElementById('login-code-field');
const codeInput = document.getElementById('login-code');
const submitBtn = document.getElementById('login-submit');
const errorBox = document.getElementById('login-error');
const hint = document.getElementById('login-hint');
const tabs = document.querySelectorAll('.login-tab');
let mode = 'login';
const MIN_PASSWORD_LENGTH = 10; // debe coincidir con MIN_PASSWORD_LENGTH en server.py

function setMode(next) {
  mode = next;
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  submitBtn.textContent = mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta';
  passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  codeField.style.display = mode === 'login' ? 'none' : 'flex';
  // El mínimo de 10 caracteres solo se exige al REGISTRAR — exigirlo
  // también al iniciar sesión bloquearía a cuentas ya existentes creadas
  // cuando el mínimo era 6, aunque su contraseña siga siendo válida.
  if (mode === 'register') {
    passwordInput.setAttribute('minlength', String(MIN_PASSWORD_LENGTH));
  } else {
    passwordInput.removeAttribute('minlength');
  }
  hint.textContent = mode === 'login'
    ? '¿No tienes cuenta? Usa "Crear cuenta" arriba.'
    : `Registro cerrado — pide el código de invitación a quien administra la plataforma. La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  errorBox.classList.remove('visible');
}
tabs.forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));

form.addEventListener('submit', (e) => {
  e.preventDefault();
  errorBox.classList.remove('visible');
  submitBtn.disabled = true;
  const endpoint = mode === 'login' ? '/api/login' : '/api/register';
  const body = { username: usernameInput.value.trim(), password: passwordInput.value };
  if (mode === 'register') body.code = codeInput.value.trim();
  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((resp) => resp.json().then((data) => ({ ok: resp.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'No se pudo completar la operación.');
      window.location.href = '/';
    })
    .catch((err) => {
      errorBox.textContent = err.message;
      errorBox.classList.add('visible');
      submitBtn.disabled = false;
    });
});

// Si ya hay sesión activa, no tiene sentido mostrar el login.
fetch('/api/me').then((r) => r.json()).then((data) => {
  if (data.authenticated) window.location.href = '/';
});
