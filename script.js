const pipelineStages = [
  { name: 'Idea Received', detail: 'Capturing project goals and constraints', status: 'complete' },
  { name: 'Research Agent', detail: 'Understanding the problem and target user', status: 'complete' },
  { name: 'GitHub Analyzer', detail: 'Reading profile signals and repo history', status: 'complete' },
  { name: 'Tech Stack Agent', detail: 'Recommending the best-fit stack', status: 'complete' },
  { name: 'Innovation Agent', detail: 'Finding standout demo-worthy features', status: 'complete' },
  { name: 'Knowledge Tracker', detail: 'Mapping skills and learning gaps', status: 'complete' },
  { name: 'Roadmap Agent', detail: 'Sequencing milestones against the deadline', status: 'running' },
  { name: 'AO Task Agent', detail: 'Scoping one narrow PR-ready coding task', status: 'waiting' },
  { name: 'AO Handoff', detail: 'Ready to send a focused task to execution', status: 'waiting' },
  { name: 'Pull Request', detail: 'Waiting for code changes and review', status: 'waiting' }
];

const pipeline = document.getElementById('pipeline');
const submitIdea = document.getElementById('submitIdea');
const ideaInput = document.getElementById('ideaInput');
const heroView = document.getElementById('heroView');
const dashboardView = document.getElementById('dashboardView');
const historyEmpty = document.getElementById('historyEmpty');
const historyList = document.getElementById('historyList');
const projectTitle = document.getElementById('projectTitle');
const projectSummary = document.getElementById('projectSummary');
const newProjectBtn = document.getElementById('newProjectBtn');
const copyPrompt = document.getElementById('copyPrompt');
const sendAo = document.getElementById('sendAo');
const handoffStatus = document.getElementById('handoffStatus');
const savePr = document.getElementById('savePr');
const prUrl = document.getElementById('prUrl');
const prStatus = document.getElementById('prStatus');

const projects = [];

function renderPipeline() {
  pipeline.innerHTML = '';
  pipelineStages.forEach((stage) => {
    const row = document.createElement('div');
    row.className = `pipeline-stage ${stage.status}`;
    row.innerHTML = `
      <div class="stage-top">
        <h4>${stage.name}</h4>
        <span class="stage-status">${stage.status.toUpperCase()}</span>
      </div>
      <p>${stage.detail}</p>
    `;
    pipeline.appendChild(row);
  });
}

function titleFromIdea(idea) {
  const cleaned = idea.replace(/\s+/g, ' ').trim();
  return cleaned.split(' ').slice(0, 5).join(' ') || 'Untitled Project';
}

function renderHistory() {
  historyList.innerHTML = '';
  if (!projects.length) {
    historyEmpty.classList.remove('hidden');
    historyList.classList.add('hidden');
    return;
  }
  historyEmpty.classList.add('hidden');
  historyList.classList.remove('hidden');
  projects.forEach((project) => {
    const card = document.createElement('button');
    card.className = 'history-card';
    card.innerHTML = `
      <h4>${project.title}</h4>
      <p>${project.description}</p>
      <div class="history-meta"><span>${project.activity}</span><span>${project.status}</span></div>
    `;
    card.addEventListener('click', () => loadProject(project));
    historyList.appendChild(card);
  });
}

function loadProject(project) {
  heroView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  projectTitle.textContent = project.title;
  projectSummary.textContent = project.description;
}

function submitProject() {
  const idea = ideaInput.value.trim();
  if (!idea) return;
  const project = {
    title: titleFromIdea(idea),
    description: idea,
    activity: 'Just now',
    status: 'Planning'
  };
  projects.unshift(project);
  renderHistory();
  loadProject(project);
  pipelineStages[6].status = 'complete';
  pipelineStages[7].status = 'running';
  pipelineStages[8].status = 'waiting';
  renderPipeline();
}

submitIdea.addEventListener('click', submitProject);
ideaInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitProject();
  }
});
newProjectBtn.addEventListener('click', () => {
  dashboardView.classList.add('hidden');
  heroView.classList.remove('hidden');
  ideaInput.focus();
});
copyPrompt.addEventListener('click', async () => {
  const text = document.querySelector('.task-spec').textContent.trim();
  await navigator.clipboard.writeText(text);
  handoffStatus.textContent = 'Copied';
});
sendAo.addEventListener('click', () => {
  handoffStatus.textContent = 'Sent to AO';
  pipelineStages[7].status = 'complete';
  pipelineStages[8].status = 'running';
  renderPipeline();
});
savePr.addEventListener('click', () => {
  if (!prUrl.value.trim()) {
    prStatus.textContent = 'PR Status: Waiting for branch';
    return;
  }
  handoffStatus.textContent = 'PR Opened';
  pipelineStages[8].status = 'complete';
  pipelineStages[9].status = 'running';
  prStatus.textContent = `PR Status: Opened ? ${prUrl.value.trim()}`;
  renderPipeline();
});

renderPipeline();
renderHistory();
