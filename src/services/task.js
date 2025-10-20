const dayjs = require('dayjs');

function parseTaskCommand(text, parseDate) {
  const taskMatch = text.match(/タスク[:：]\s*(.+?)\s*\/\s*終(了|了時刻)?[:：]\s*(.+)/);
  if (!taskMatch) return null;

  const title = taskMatch[1].trim();
  const endTimeStr = taskMatch[3].trim();
  const parsed = parseDate(endTimeStr);
  if (!parsed) return null;

  return {
    title,
    dueIso: parsed.isoUtc,
    jst: parsed.jst,
  };
}

async function createTaskWithReminders({ supabase, profileId, title, dueIso }) {
  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .insert({
      user_id: profileId,
      title,
      end_at: dueIso,
      status: 'open'
    })
    .select()
    .single();

  if (taskError) throw taskError;

  const end = dayjs(task.end_at);
  const reminder30min = end.subtract(30, 'minute').utc().toISOString();
  const reminder0min = end.utc().toISOString();

  await supabase.from('task_reminders').insert([
    { task_id: task.id, user_id: profileId, run_at: reminder30min, kind: 'T-30' },
    { task_id: task.id, user_id: profileId, run_at: reminder0min, kind: 'T0' }
  ]);

  return task;
}

module.exports = {
  parseTaskCommand,
  createTaskWithReminders,
};
