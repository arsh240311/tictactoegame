// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store rooms and their data
const rooms = new Map();
const players = new Map();

// Generate random room ID
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Initialize game state for a room
function initializeGameState(roomId) {
  rooms.set(roomId, {
    players: new Map(),
    board: Array(9).fill(''),
    currentPlayer: 'X',
    gameActive: true,
    winningCombinations: [
      [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
      [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
      [0, 4, 8], [2, 4, 6]             // diagonals
    ],
    scores: { winsX: 0, winsO: 0, draws: 0 }
  });
}

io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);
  
  // Handle creating a room
  socket.on('createRoom', (playerName) => {
    const roomId = generateRoomId();
    initializeGameState(roomId);
    
    const room = rooms.get(roomId);
    room.players.set(socket.id, { id: socket.id, name: playerName, role: 'X' });
    
    players.set(socket.id, { roomId, role: 'X' });
    socket.join(roomId);
    
    console.log(`Player ${playerName} created room ${roomId}`);
    socket.emit('roomCreated', roomId);
    
    // Send initial room state
    socket.emit('roomState', {
      roomId,
      players: Array.from(room.players.values()),
      board: room.board,
      currentPlayer: room.currentPlayer,
      scores: room.scores
    });
  });
  
  // Handle joining a room
  socket.on('joinRoom', ({ roomId, playerName }) => {
    if (!rooms.has(roomId)) {
      socket.emit('roomError', 'Room not found');
      return;
    }
    
    const room = rooms.get(roomId);
    if (room.players.size >= 2) {
      socket.emit('roomError', 'Room is full');
      return;
    }
    
    // Assign role O to the joining player
    const role = 'O';
    room.players.set(socket.id, { id: socket.id, name: playerName, role });
    players.set(socket.id, { roomId, role });
    socket.join(roomId);
    
    console.log(`Player ${playerName} joined room ${roomId}`);
    
    // Notify all players in the room about the new player
    io.to(roomId).emit('playerJoined', Array.from(room.players.values()));
    
    // Send initial room state to the new player
    socket.emit('roomState', {
      roomId,
      players: Array.from(room.players.values()),
      board: room.board,
      currentPlayer: room.currentPlayer,
      scores: room.scores
    });
    
    // Notify room that the game can start
    io.to(roomId).emit('gameReady');
  });
  
  // Handle player making a move
  socket.on('makeMove', ({ roomId, cellIndex }) => {
    if (!rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    const player = players.get(socket.id);
    
    // Validate move
    if (!player || room.players.get(socket.id).role !== room.currentPlayer) {
      socket.emit('moveError', "It's not your turn!");
      return;
    }
    
    if (room.board[cellIndex] !== '' || !room.gameActive) {
      socket.emit('moveError', 'Invalid move');
      return;
    }
    
    // Update board
    room.board[cellIndex] = room.currentPlayer;
    
    // Broadcast move to all players in the room
    io.to(roomId).emit('moveMade', {
      cellIndex,
      player: room.currentPlayer,
      board: room.board
    });
    
    // Check for win
    const winResult = checkWin(room);
    if (winResult.win) {
      room.gameActive = false;
      // Update scores
      if (winResult.winner === 'X') {
        room.scores.winsX++;
      } else if (winResult.winner === 'O') {
        room.scores.winsO++;
      }
      io.to(roomId).emit('gameWon', {
        winner: winResult.winner,
        winningCells: winResult.winningCells,
        scores: room.scores
      });
      return;
    }
    
    // Check for draw
    if (checkDraw(room.board)) {
      room.gameActive = false;
      room.scores.draws++;
      io.to(roomId).emit('gameDraw', { scores: room.scores });
      return;
    }
    
    // Switch turns
    room.currentPlayer = room.currentPlayer === 'X' ? 'O' : 'X';
    io.to(roomId).emit('turnChanged', room.currentPlayer);
  });
  
  // Handle chat messages
  socket.on('sendMessage', ({ roomId, message }) => {
    if (!rooms.has(roomId)) return;
    
    const player = players.get(socket.id);
    if (!player) return;
    
    const playerName = rooms.get(roomId).players.get(socket.id).name;
    io.to(roomId).emit('messageReceived', {
      playerId: socket.id,
      playerName,
      message
    });
  });
  
  // Handle reset game
  socket.on('resetGame', (roomId) => {
    if (!rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    resetGame(room);
    
    io.to(roomId).emit('gameReset', {
      board: room.board,
      currentPlayer: room.currentPlayer
    });
  });
  
  // Handle player disconnection
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    
    const playerInfo = players.get(socket.id);
    if (!playerInfo) return;
    
    const { roomId } = playerInfo;
    if (!rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    room.players.delete(socket.id);
    players.delete(socket.id);
    
    // If room becomes empty, delete it
    if (room.players.size === 0) {
      rooms.delete(roomId);
      console.log(`Room ${roomId} deleted`);
    } else {
      // Notify remaining player about disconnection
      io.to(roomId).emit('playerLeft', socket.id);
      console.log(`Player ${socket.id} left room ${roomId}`);
    }
  });
});

// Check for win
function checkWin(room) {
  for (const combination of room.winningCombinations) {
    const [a, b, c] = combination;
    if (
      room.board[a] !== '' &&
      room.board[a] === room.board[b] &&
      room.board[a] === room.board[c]
    ) {
      return {
        win: true,
        winner: room.board[a],
        winningCells: combination
      };
    }
  }
  return { win: false };
}

// Check for draw
function checkDraw(board) {
  return board.every(cell => cell !== '');
}

// Reset game state
function resetGame(room) {
  room.board.fill('');
  room.gameActive = true;
  // Alternate who starts first
  room.currentPlayer = room.currentPlayer === 'X' ? 'O' : 'X';
}

// Start server - Modified IP binding
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`Server running on ${HOST}:${PORT}`);
});