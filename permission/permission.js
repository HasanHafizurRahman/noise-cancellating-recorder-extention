/**
 * CrispRec Microphone Permission Handler
 * Invoked in a dedicated tab where Chrome supports full browser permission prompts.
 */

const allowBtn = document.getElementById('allow-btn');
const skipBtn = document.getElementById('skip-btn');
const statusMsg = document.getElementById('status-msg');

allowBtn.addEventListener('click', async () => {
  allowBtn.disabled = true;
  allowBtn.innerHTML = '<span>Requesting Chrome permission...</span>';
  statusMsg.className = 'status-msg';
  statusMsg.textContent = 'Please click "Allow" in the browser popup prompt above...';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Stop tracks immediately after granting
    stream.getTracks().forEach((track) => track.stop());

    statusMsg.className = 'status-msg status-success';
    statusMsg.textContent = '✓ Microphone permission granted! Closing this tab...';
    allowBtn.innerHTML = '<span>✓ Permission Granted</span>';

    setTimeout(() => {
      window.close();
    }, 1200);
  } catch (err) {
    console.error('Permission error:', err);
    allowBtn.disabled = false;
    allowBtn.innerHTML = '<span>🎙️ Try Again</span>';
    statusMsg.className = 'status-msg status-error';

    if (err.name === 'NotAllowedError') {
      statusMsg.textContent = 'Microphone access was blocked. Please click the camera/mic icon in the Chrome address bar to allow access.';
    } else {
      statusMsg.textContent = `Error: ${err.message || 'Permission denied'}`;
    }
  }
});

skipBtn.addEventListener('click', () => {
  window.close();
});

// Auto-check if already granted
(async () => {
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const res = await navigator.permissions.query({ name: 'microphone' });
      if (res.state === 'granted') {
        statusMsg.className = 'status-msg status-success';
        statusMsg.textContent = '✓ Microphone is already enabled! Closing tab...';
        setTimeout(() => window.close(), 1000);
      }
    }
  } catch (e) {}
})();

