const enabled = document.querySelector('#enabled');
const status = document.querySelector('#status');
const captureNow = document.querySelector('#capture-now');
const timelinePass = document.querySelector('#timeline-pass');
const diagProfile = document.querySelector('#diag-profile');
const diagArticles = document.querySelector('#diag-articles');
const diagParsed = document.querySelector('#diag-parsed');
const diagSent = document.querySelector('#diag-sent');
const diagLast = document.querySelector('#diag-last');
const diagSample = document.querySelector('#diag-sample');

chrome.storage.local.get({ enabled: true, lastCapture: null }, (state) => {
  enabled.checked = Boolean(state.enabled);
  renderDiagnostics(state.lastCapture);
});

enabled.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: enabled.checked });
});

captureNow.addEventListener('click', () => {
  sendToActiveTab({ type: 'captureNow' });
});

timelinePass.addEventListener('click', () => {
  sendToActiveTab({ type: 'startTimelinePass' });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.lastCapture) {
    renderDiagnostics(changes.lastCapture.newValue);
  }
});

fetch('http://127.0.0.1:3197/health')
  .then((response) => response.ok ? response.json() : Promise.reject(new Error('offline')))
  .then(() => {
    status.textContent = 'Online';
    status.className = 'status ok';
  })
  .catch(() => {
    status.textContent = 'Offline';
    status.className = 'status offline';
  });

function sendToActiveTab(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id || !/^https:\/\/(x|twitter)\.com\//.test(tab.url || '')) {
      renderDiagnostics({
        serverOk: false,
        serverError: '请先切到 X profile 标签页。'
      });
      return;
    }

    chrome.tabs.sendMessage(tab.id, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        renderDiagnostics({
          serverOk: false,
          serverError: `${error.message}。请刷新 X 页面后重试。`
        });
        return;
      }

      if (response?.status) renderDiagnostics(response.status);
    });
  });
}

function renderDiagnostics(lastCapture) {
  if (!lastCapture) return;

  diagProfile.textContent = lastCapture.profileHandle ? `@${lastCapture.profileHandle}` : '-';
  diagArticles.textContent = String(lastCapture.articleCount ?? '-');
  diagParsed.textContent = String(lastCapture.parsedCount ?? '-');
  diagSent.textContent = String(lastCapture.storedCount ?? lastCapture.sentCount ?? '-');
  diagLast.textContent = formatLast(lastCapture);
  diagSample.textContent = lastCapture.sampleText || lastCapture.serverError || '-';
  timelinePass.disabled = Boolean(lastCapture.passRunning);
  timelinePass.textContent = lastCapture.passRunning ? '采集中...' : '慢速滚动采集';
}

function formatLast(lastCapture) {
  if (lastCapture.serverError) return lastCapture.serverError;
  if (!lastCapture.updatedAt) return '-';
  const time = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(lastCapture.updatedAt));
  return `${time} · ${lastCapture.reason || 'scan'}`;
}
