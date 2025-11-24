// api/slack.js - Vercel Serverless Function
// Ultra-lightweight Slack sales leaderboard with KV storage

const KV_NAMESPACE = 'sales_records';

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

async function getRecords(type) {
  const currentMonth = getCurrentMonth();
  const keys = await storage.keys(`${currentMonth}:${type}:`);
  const records = [];
  
  for (const key of keys) {
    const data = await storage.get(key);
    if (data) records.push(JSON.parse(data));
  }
  
  return records;
}

async function addRecord(type, name, value, details = '') {
  const month = getCurrentMonth();
  const timestamp = Date.now();
  const key = `${month}:${type}:${timestamp}`;
  
  const record = {
    type,
    name,
    value: parseFloat(value),
    details,
    timestamp,
    date: new Date().toISOString()
  };
  
  await storage.set(key, JSON.stringify(record));
  return record;
}

function buildLeaderboard(records, type) {
  const grouped = records.reduce((acc, r) => {
    if (!acc[r.name]) {
      acc[r.name] = { name: r.name, total: 0, count: 0, values: [] };
    }
    acc[r.name].total += r.value;
    acc[r.name].count += 1;
    acc[r.name].values.push(r.value);
    return acc;
  }, {});

  let sorted = Object.values(grouped);
  
  if (type === 'time') {
    // For time, calculate average and sort ascending (lower is better)
    sorted = sorted.map(rep => ({
      ...rep,
      avg: rep.total / rep.count
    })).sort((a, b) => a.avg - b.avg);
  } else {
    // For ARR and pilots, sort descending (higher is better)
    sorted = sorted.sort((a, b) => b.total - a.total);
  }

  return sorted.slice(0, 10);
}

function formatLeaderboardResponse(leaderboard, type) {
  if (leaderboard.length === 0) {
    return {
      response_type: "in_channel",
      text: `📊 *${type.toUpperCase()} Leaderboard - ${getCurrentMonth()}*\n\nNo records yet this month. Be the first! 🚀`
    };
  }

  const medals = ['🥇', '🥈', '🥉'];
  let text = `📊 *${type.toUpperCase()} Leaderboard - ${getCurrentMonth()}*\n\n`;

  leaderboard.forEach((rep, idx) => {
    const medal = medals[idx] || `${idx + 1}.`;
    
    if (type === 'arr') {
      text += `${medal} *${rep.name}* — ${formatCurrency(rep.total)}`;
      if (rep.count > 1) text += ` (${rep.count} deals)`;
    } else if (type === 'pilot') {
      text += `${medal} *${rep.name}* — ${rep.count} pilot${rep.count > 1 ? 's' : ''}`;
    } else if (type === 'time') {
      text += `${medal} *${rep.name}* — ${Math.round(rep.avg)} days avg`;
      if (rep.count > 1) text += ` (${rep.count} deals)`;
    }
    
    text += '\n';
  });

  return {
    response_type: "in_channel",
    text
  };
}

function formatRecordResponse(record, type) {
  let text = '🎉 *New Record Added!*\n\n';
  
  if (type === 'arr') {
    text += `💰 *${record.name}* closed ${formatCurrency(record.value)} ARR`;
  } else if (type === 'pilot') {
    text += `🚀 *${record.name}* signed ${record.value} pilot${record.value > 1 ? 's' : ''}`;
  } else if (type === 'time') {
    text += `⚡ *${record.name}* went from discovery to pilot in ${Math.round(record.value)} days`;
  }
  
  if (record.details) {
    text += `\n_${record.details}_`;
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
\`/sales record arr <name> <amount> [details]\`
Example: \`/sales record arr Sarah 50000 Acme Corp\`

\`/sales record pilot <name> <count> [details]\`
Example: \`/sales record pilot John 2 BigCo pilots\`

\`/sales record time <name> <days> [details]\`
Example: \`/sales record time Maria 14 TechStart deal\`

*View leaderboards:*
\`/sales leaderboard arr\` - Top ARR this month
\`/sales leaderboard pilot\` - Most pilots this month  
\`/sales leaderboard time\` - Fastest discovery→pilot

*Shortcuts:*
\`/sales arr\` - View ARR leaderboard
\`/sales pilot\` - View pilot leaderboard
\`/sales time\` - View time leaderboard`
  };
}

async function handleSlackCommand(text) {
  const parts = text.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase();

  // Help or empty command
  if (!command || command === 'help') {
    return getHelpText();
  }

  // Record command
  if (command === 'record') {
    const [_, type, name, value, ...detailsParts] = parts;
    const details = detailsParts.join(' ');

    if (!type || !name || !value) {
      return {
        response_type: "ephemeral",
        text: "❌ Usage: `/sales record <type> <name> <value> [details]`\nType must be: arr, pilot, or time"
      };
    }

    const validTypes = ['arr', 'pilot', 'time'];
    if (!validTypes.includes(type)) {
      return {
        response_type: "ephemeral",
        text: "❌ Type must be: arr, pilot, or time"
      };
    }

    const numValue = parseFloat(value);
    if (isNaN(numValue) || numValue <= 0) {
      return {
        response_type: "ephemeral",
        text: "❌ Value must be a positive number"
      };
    }

    const record = await addRecord(type, name, numValue, details);
    return formatRecordResponse(record, type);
  }

  // Leaderboard commands
  if (command === 'leaderboard' || ['arr', 'pilot', 'time'].includes(command)) {
    const type = command === 'leaderboard' ? parts[1]?.toLowerCase() : command;

    if (!type || !['arr', 'pilot', 'time'].includes(type)) {
      return {
        response_type: "ephemeral",
        text: "❌ Usage: `/sales leaderboard <type>`\nType must be: arr, pilot, or time"
      };
    }

    const records = await getRecords(type);
    const leaderboard = buildLeaderboard(records, type);
    return formatLeaderboardResponse(leaderboard, type);
  }

  return {
    response_type: "ephemeral",
    text: "❌ Unknown command. Type `/sales help` for usage."
  };
}

export default async function handler(req) {
  // Verify it's a POST request
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    // Parse form data from Slack
    const formData = await req.formData();
    const text = formData.get('text') || '';
    const token = formData.get('token');

    // Optional: Verify Slack token (set SLACK_VERIFICATION_TOKEN in Vercel env vars)
    const expectedToken = process.env.SLACK_VERIFICATION_TOKEN;
    if (expectedToken && token !== expectedToken) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Handle the command
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