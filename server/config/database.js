const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '../data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PAGES_FILE = path.join(DATA_DIR, 'pages.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize files if they don't exist
const initializeFile = (filePath, defaultData) => {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
  }
};

// Read data from file
const readData = (filePath) => {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
};

// Write data to file
const writeData = (filePath, data) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};

// Create default users
const createDefaultUsers = async () => {
  const existingUsers = readData(USERS_FILE);
  if (existingUsers.length === 0) {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword1 = await bcrypt.hash('password123', salt);
    const hashedPassword2 = await bcrypt.hash('password123', salt);

    const defaultUsers = [
      {
        id: uuidv4(),
        username: 'user1',
        email: 'user1@example.com',
        password: hashedPassword1,
        color: '#3B82F6',
        createdAt: new Date().toISOString()
      },
      {
        id: uuidv4(),
        username: 'user2',
        email: 'user2@example.com',
        password: hashedPassword2,
        color: '#10B981',
        createdAt: new Date().toISOString()
      }
    ];

    writeData(USERS_FILE, defaultUsers);
    console.log('Default users created: user1 and user2 (password: password123)');
  }
};

initializeFile(USERS_FILE, []);
initializeFile(PAGES_FILE, []);

// Initialize default users
createDefaultUsers();

// User operations
const db = {
  users: {
    findAll: () => readData(USERS_FILE),
    findById: (id) => readData(USERS_FILE).find(u => u.id === id),
    findByEmail: (email) => readData(USERS_FILE).find(u => u.email === email),
    findByUsername: (username) => readData(USERS_FILE).find(u => u.username === username),
    create: (user) => {
      const users = readData(USERS_FILE);
      const newUser = { id: uuidv4(), ...user, createdAt: new Date().toISOString() };
      users.push(newUser);
      writeData(USERS_FILE, users);
      return newUser;
    },
    update: (id, updates) => {
      const users = readData(USERS_FILE);
      const index = users.findIndex(u => u.id === id);
      if (index !== -1) {
        users[index] = { ...users[index], ...updates };
        writeData(USERS_FILE, users);
        return users[index];
      }
      return null;
    }
  },

  pages: {
    findAll: () => readData(PAGES_FILE),
    findById: (id) => readData(PAGES_FILE).find(p => p.id === id),
    findByUser: (userId) => readData(PAGES_FILE).filter(p =>
      p.ownerId === userId || p.sharedWith.includes(userId)
    ),
    create: (page) => {
      const pages = readData(PAGES_FILE);
      const newPage = {
        id: uuidv4(),
        ...page,
        blocks: page.blocks || [],
        sharedWith: page.sharedWith || [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      pages.push(newPage);
      writeData(PAGES_FILE, pages);
      return newPage;
    },
    update: (id, updates) => {
      const pages = readData(PAGES_FILE);
      const index = pages.findIndex(p => p.id === id);
      if (index !== -1) {
        pages[index] = { ...pages[index], ...updates, updatedAt: new Date().toISOString() };
        writeData(PAGES_FILE, pages);
        return pages[index];
      }
      return null;
    },
    delete: (id) => {
      const pages = readData(PAGES_FILE);
      const index = pages.findIndex(p => p.id === id);
      if (index !== -1) {
        pages.splice(index, 1);
        writeData(PAGES_FILE, pages);
        return true;
      }
      return false;
    }
  }
};

module.exports = db;
