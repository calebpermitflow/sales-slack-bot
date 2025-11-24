// api/slack.js - Vercel Serverless Function
// Ultra-lightweight Slack sales leaderboard with KV storage

export const config = {
  runtime: 'edge',
};

// In-memory KV store (use Vercel KV for production)
const storage = {
  data: new Map(),
  async get(key) {
    return this.data.get(key) || null;
  },
  async set(key, value) {
    this.data.set(key, value);
  },
  async keys(prefix = '') {
    return Array.from(this.data.keys()).filter(k => k.startsWith(prefix));
  }
};

const ARR_GOAL = 2000000; // $2M goal

function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function formatCurrency(num) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(num);
}

function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

async function incrementPilot(name) {
  const month = getCurrentMonth();
  const key = `pilot:${month}:${name.toLowerCase()}`;
  
  let count = await storage.get(key);
  count = count ? parseInt(count) : 0;
  count += 1;
  
  await storage.set(key, count.toString());
  return count;
}

async function addPilotTime(name, minutes) {
  const month = getCurrentMonth();
  const timestamp = Date.now();
  const key = `pilottime:${month}:${timestamp}`;
  
  const record = {
    name,
    minutes: parseInt(minutes),
    timestamp,
    date: new Date().toISOString(),
    month
  };
  
  await storage.set(key, JSON.stringify(record));
  
  // Check if it's an all-time record
  const allTimeKey = 'pilottime:alltime';
  let allTimeRecord = await storage.get(allTimeKey);
  
  if (allTimeRecord) {
    allTimeRecord = JSON.parse(allTimeRecord);
    if (record.minutes < allTimeRecord.minutes) {
      await storage.set(allTimeKey, JSON.stringify(record));
      return { record, isAllTime: true };
    }
  } else {
    await storage.set(allTimeKey, JSON.stringify(record));
    return { record, isAllTime: true };
  }
  
  return { record, isAllTime: false };
}

async function addARR(name, amount) {
  const month = getCurrentMonth();
  const timestamp = Date.now();
  const key = `arr:${month}:${timestamp}`;
  
  const record = {
    name,
    amount: parseFloat(amount),
    timestamp,
    date: new Date().toISOString()
  };
  
  await storage.set(key, JSON.stringify(record));
  
  // Calculate total ARR for the month
  const monthTotal = await getMonthlyARRTotal();
  
  return { record, monthTotal };
}

async function getMonthlyARRTotal() {
  const month = getCurrentMonth();
  const keys = await storage.keys(`arr:${month}:`);
  let total = 0;
  
  for (const key of keys) {
    const data = await storage.get(key);
    if (data) {
      const record = JSON.parse(data);
      total += record.amount;
    }
  }
  
  return total;
}

async function getPilotLeaderboard() {
  const month = getCurrentMonth();
  const keys = await storage.keys(`pilot:${month}:`);
  const leaderboard = [];
  
  for (const key of keys) {
    const count = await storage.get(key);
    const name = key.split(':')[2];
    if (count && parseInt(count) > 0) {
      leaderboard.push({
        name: name.charAt(0).toUpperCase() + name.slice(1),
        count: parseInt(count)
      });
    }
  }
  
  return leaderboard.sort((a, b) => b.count - a.count);
}

async function getPilotTimeLeaderboard() {
  const month = getCurrentMonth();
  const keys = await storage.keys(`pilottime:${month}:`);
  const times = [];
  
  for (const key of keys) {
    const data = await storage.get(key);
    if (data) {
      const record = JSON.parse(data);
      
      // Keep only the fastest time per rep
      const existing = times.find(t => t.name.toLowerCase() === record.name.toLowerCase());
      if (existing) {
        if (record.minutes < existing.minutes) {
          existing.minutes = record.minutes;
          existing.date = record.date;
        }
      } else {
        times.push(record);
      }
    }
  }
  
  const sorted = times.sort((a, b) => a.minutes - b.minutes).slice(0, 3);
  
  // Get all-time record
  const allTimeKey = 'pilottime:alltime';
  let allTimeRecord = await storage.get(allTimeKey);
  if (allTimeRecord) {
    allTimeRecord = JSON.parse(allTimeRecord);
  }
  
  return { monthly: sorted, allTime: allTimeRecord };
}

async function getARRLeaderboard() {
  const month = getCurrentMonth();
  const keys = await storage.keys(`arr:${month}:`);
  const grouped = {};
  
  for (const key of keys) {
    const data = await storage.get(key);
    if (data) {
      const record = JSON.parse(data);
      const nameLower = record.name.toLowerCase();
      if (!grouped[nameLower]) {
        grouped[nameLower] = {
          name: record.name,
          total: 0
        };
      }
      grouped[nameLower].total += record.amount;
    }
  }
  
  const leaderboard = Object.values(grouped)
    .filter(rep => rep.total > 0)
    .sort((a, b) => b.total - a.total);
  
  const monthTotal = await getMonthlyARRTotal();
  
  return { leaderboard, monthTotal };
}

function formatPilotLeaderboard(leaderboard) {
  if (leaderboard.length === 0) {
    return {
      response_type: "in_channel",
      text: `📊 *Pilot Leaderboard - ${getCurrentMonth()}*\n\nNo pilots signed yet this month. Be the first! 🚀`
    };
  }

  const medals = ['🥇', '🥈', '🥉'];
  let text = `📊 *Pilot Leaderboard - ${getCurrentMonth()}*\n\n`;

  leaderboard.forEach((rep, idx) => {
    const medal = medals[idx] || `${idx + 1}.`;
    text += `${medal} *${rep.name}* — ${rep.count} pilot${rep.count > 1 ? 's' : ''}\n`;
  });

  return {
    response_type: "in_channel",
    text
  };
}

function formatPilotTimeLeaderboard(data) {
  const { monthly, allTime } = data;
  
  let text = `⚡ *Fastest Pilot Times - ${getCurrentMonth()}*\n\n`;
  
  if (monthly.length === 0) {
    text += 'No times recorded yet this month.\n\n';
  } else {
    const medals = ['🥇', '🥈', '🥉'];
    monthly.forEach((record, idx) => {
      const medal = medals[idx] || `${idx + 1}.`;
      text += `${medal} *${record.name}* — ${record.minutes} min\n`;
    });
  }
  
  if (allTime) {
    text += `\n🏆 *All-Time Record:* ${allTime.name} — ${allTime.minutes} min (${formatDate(allTime.date)})`;
  }

  return {
    response_type: "in_channel",
    text
  };
}

function formatARRLeaderboard(data) {
  const { leaderboard, monthTotal } = data;
  
  const percentage = ((monthTotal / ARR_GOAL) * 100).toFixed(1);
  let text = `📊 *ARR Leaderboard - ${getCurrentMonth()}*\n`;
  text += `🎯 Goal: ${formatCurrency(monthTotal)} / ${formatCurrency(ARR_GOAL)} (${percentage}%)\n\n`;
  
  if (leaderboard.length === 0) {
    text += 'No ARR recorded yet this month. Time to close some deals! 💪';
  } else {
    const medals = ['🥇', '🥈', '🥉'];
    leaderboard.forEach((rep, idx) => {
      const medal = medals[idx] || `${idx + 1}.`;
      text += `${medal} *${rep.name}* — ${formatCurrency(rep.total)}\n`;
    });
  }

  return {
    response_type: "in_channel",
    text
  };
}

function getHelpText() {
  return {
    response_type: "ephemeral",
    text: `*Sales Leaderboard Commands* 🏆

*Record achievements:*
\`/sales pilot <name>\` - Add +1 pilot
Example: \`/sales pilot Matt\`

\`/sales pilot-time <name> <minutes>\` - Record discovery→pilot time
Example: \`/sales pilot-time Sarah 24\`

\`/sales arr <name> <amount>\` - Record ARR deal
Example: \`/sales arr John 50000\`

*View leaderboards:*
\`/sales pilot\` - Pilot count this month
\`/sales pilot-time\` - Fastest times (top 3 + all-time)
\`/sales arr\` - ARR leaderboard with $2M goal progress`
  };
}

async function handleSlackCommand(text) {
  const parts = text.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase();

  // Help or empty command
  if (!command || command === 'help') {
    return getHelpText();
  }

  // Pilot count
  if (command === 'pilot') {
    if (parts.length === 1) {
      // View leaderboard
      const leaderboard = await getPilotLeaderboard();
      return formatPilotLeaderboard(leaderboard);
    } else {
      // Add pilot
      const name = parts[1];
      const count = await incrementPilot(name);
      
      return {
        response_type: "in_channel",
        text: `🎉 *${name}* signed a pilot! Total this month: *${count}*`
      };
    }
  }

  // Pilot time
  if (command === 'pilot-time') {
    if (parts.length === 1) {
      // View leaderboard
      const data = await getPilotTimeLeaderboard();
      return formatPilotTimeLeaderboard(data);
    } else if (parts.length >= 3) {
      // Record time
      const name = parts[1];
      const minutes = parts[2];
      
      if (isNaN(minutes) || parseInt(minutes) <= 0) {
        return {
          response_type: "ephemeral",
          text: "❌ Minutes must be a positive number"
        };
      }
      
      const { record, isAllTime } = await addPilotTime(name, minutes);
      
      let text = `🎉 *New Pilot Time!*\n\n⚡ *${record.name}* went from discovery to pilot in *${record.minutes} minutes*`;
      
      if (isAllTime) {
        text += `\n\n🏆 *NEW ALL-TIME RECORD!* 🏆`;
      }
      
      return {
        response_type: "in_channel",
        text
      };
    } else {
      return {
        response_type: "ephemeral",
        text: "❌ Usage: `/sales pilot-time <name> <minutes>`"
      };
    }
  }

  // ARR
  if (command === 'arr') {
    if (parts.length === 1) {
      // View leaderboard
      const data = await getARRLeaderboard();
      return formatARRLeaderboard(data);
    } else if (parts.length >= 3) {
      // Record ARR
      const name = parts[1];
      const amount = parts[2];
      
      if (isNaN(amount) || parseFloat(amount) <= 0) {
        return {
          response_type: "ephemeral",
          text: "❌ Amount must be a positive number"
        };
      }
      
      const { record, monthTotal } = await addARR(name, amount);
      const percentage = ((monthTotal / ARR_GOAL) * 100).toFixed(1);
      
      let text = `🎉 *New ARR Deal!*\n\n💰 *${record.name}* closed ${formatCurrency(record.amount)} ARR\n\n`;
      text += `📊 Team Progress: ${formatCurrency(monthTotal)} / ${formatCurrency(ARR_GOAL)} (${percentage}%)`;
      
      return {
        response_type: "in_channel",
        text
      };
    } else {
      return {
        response_type: "ephemeral",
        text: "❌ Usage: `/sales arr <name> <amount>`"
      };
    }
  }

  return {
    response_type: "ephemeral",
    text: "❌ Unknown command. Type `/sales help` for usage."
  };
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const formData = await req.formData();
    const text = formData.get('text') || '';
    const token = formData.get('token');

    const expectedToken = process.env.SLACK_VERIFICATION_TOKEN;
    if (expectedToken && token !== expectedToken) {
      return new Response('Unauthorized', { status: 401 });
    }

    const response = await handleSlackCommand(text);

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({
      response_type: "ephemeral",
      text: "❌ An error occurred. Please try again."
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }
}
