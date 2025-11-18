// Servidor Node.js para servir os arquivos estáticos
// com os Content-Types corretos para instalação iOS
// e registro automático de dispositivos

const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();

// Servir manifest.plist com Content-Type correto (CRÍTICO para iOS)
app.get('/manifest.plist', (req, res) => {
  const manifestPath = path.join(__dirname, 'manifest.plist');
  
  console.log('📋 Requisição para manifest.plist recebida');
  
  // Definir headers corretos ANTES de enviar
  // IMPORTANTE: Content-Type deve ser application/xml para iOS aceitar
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Verificar se o arquivo existe
  if (!fs.existsSync(manifestPath)) {
    console.error('❌ manifest.plist não encontrado!');
    return res.status(404).send('manifest.plist not found');
  }
  
  // Ler e enviar o arquivo
  try {
    const manifestContent = fs.readFileSync(manifestPath, 'utf8');
    console.log('✅ manifest.plist enviado com Content-Type: application/xml');
    res.send(manifestContent);
  } catch (error) {
    console.error('❌ Erro ao ler manifest.plist:', error);
    res.status(500).send('Error reading manifest.plist');
  }
});

// Middleware para parsear JSON
app.use(express.json());

// Armazenar dispositivos registrados e builds em andamento
const registeredDevices = new Set();
const pendingBuilds = new Map();

// Endpoint para registrar dispositivo automaticamente
app.post('/api/register-device', async (req, res) => {
  try {
    const { udid, deviceName } = req.body;
    
    if (!udid) {
      return res.status(400).json({ 
        success: false, 
        error: 'UDID é obrigatório' 
      });
    }

    console.log(`📱 Tentando registrar dispositivo: ${udid} (${deviceName || 'Sem nome'})`);

    // Verificar se já está registrado
    if (registeredDevices.has(udid)) {
      return res.json({ 
        success: true, 
        message: 'Dispositivo já registrado',
        alreadyRegistered: true,
        udid 
      });
    }

    // Registrar dispositivo via EAS CLI
    // Nota: Isso requer que o EAS CLI esteja instalado e configurado
    try {
      const deviceNameSafe = deviceName || `iPhone-${udid.slice(-8)}`;
      // O servidor está em APP/public/, então precisamos subir um nível para APP/
      const appDir = path.join(__dirname, '..');
      const command = `cd "${appDir}" && npx eas-cli device:create --udid ${udid} --name "${deviceNameSafe}" --non-interactive`;
      
      console.log(`🔧 Executando: ${command}`);
      
      const { stdout, stderr } = await execAsync(command, {
        timeout: 30000, // 30 segundos
        maxBuffer: 1024 * 1024 * 10 // 10MB
      });

      console.log(`✅ Dispositivo registrado: ${stdout}`);
      
      registeredDevices.add(udid);
      
      return res.json({ 
        success: true, 
        message: 'Dispositivo registrado com sucesso',
        udid,
        output: stdout
      });
    } catch (error) {
      console.error(`❌ Erro ao registrar dispositivo: ${error.message}`);
      
      // Se o erro for porque já está registrado, considerar sucesso
      if (error.message.includes('already registered') || error.message.includes('already exists')) {
        registeredDevices.add(udid);
        return res.json({ 
          success: true, 
          message: 'Dispositivo já estava registrado',
          udid,
          alreadyRegistered: true
        });
      }
      
      return res.status(500).json({ 
        success: false, 
        error: 'Erro ao registrar dispositivo',
        details: error.message,
        stderr: error.stderr
      });
    }
  } catch (error) {
    console.error('❌ Erro no endpoint /api/register-device:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Erro interno do servidor',
      details: error.message
    });
  }
});

// Endpoint para disparar build automático
app.post('/api/trigger-build', async (req, res) => {
  try {
    const { udid } = req.body;
    
    if (!udid) {
      return res.status(400).json({ 
        success: false, 
        error: 'UDID é obrigatório' 
      });
    }

    // Verificar se já tem build pendente para este dispositivo
    if (pendingBuilds.has(udid)) {
      const buildInfo = pendingBuilds.get(udid);
      return res.json({ 
        success: true, 
        message: 'Build já está em andamento',
        buildId: buildInfo.buildId,
        status: buildInfo.status
      });
    }

    console.log(`🚀 Disparando build para dispositivo: ${udid}`);

    // Disparar build via EAS CLI
    try {
      // O servidor está em APP/public/, então precisamos subir um nível para APP/
      const appDir = path.join(__dirname, '..');
      const command = `cd "${appDir}" && npx eas-cli build --platform ios --profile ad-hoc --non-interactive --no-wait`;
      
      console.log(`🔧 Executando: ${command}`);
      
      const { stdout, stderr } = await execAsync(command, {
        timeout: 60000, // 60 segundos
        maxBuffer: 1024 * 1024 * 10 // 10MB
      });

      // Extrair build ID do output (se disponível)
      const buildIdMatch = stdout.match(/build ID: ([a-zA-Z0-9-]+)/i) || 
                          stdout.match(/Build ID: ([a-zA-Z0-9-]+)/i);
      const buildId = buildIdMatch ? buildIdMatch[1] : 'unknown';

      console.log(`✅ Build disparado: ${buildId}`);
      
      pendingBuilds.set(udid, {
        buildId,
        status: 'pending',
        startedAt: new Date().toISOString()
      });
      
      return res.json({ 
        success: true, 
        message: 'Build disparado com sucesso',
        buildId,
        status: 'pending',
        note: 'O build pode levar alguns minutos. Você será notificado quando estiver pronto.'
      });
    } catch (error) {
      console.error(`❌ Erro ao disparar build: ${error.message}`);
      return res.status(500).json({ 
        success: false, 
        error: 'Erro ao disparar build',
        details: error.message,
        stderr: error.stderr
      });
    }
  } catch (error) {
    console.error('❌ Erro no endpoint /api/trigger-build:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Erro interno do servidor',
      details: error.message
    });
  }
});

// Endpoint para verificar status do build
app.get('/api/build-status/:udid', (req, res) => {
  const { udid } = req.params;
  const buildInfo = pendingBuilds.get(udid);
  
  if (!buildInfo) {
    return res.json({ 
      success: false, 
      message: 'Nenhum build encontrado para este dispositivo'
    });
  }
  
  return res.json({ 
    success: true, 
    ...buildInfo
  });
});

// Endpoint para obter informações do dispositivo (para registro)
app.get('/device-info', (req, res) => {
  // Retornar informações úteis para registro de dispositivo
  res.json({
    message: 'Para registrar seu dispositivo, você precisa:',
    steps: [
      '1. Obter o UDID do seu iPhone (Ajustes > Geral > Sobre > Identificador)',
      '2. Registrar no Apple Developer Portal ou via EAS Build',
      '3. Gerar um novo build com o dispositivo registrado',
      '4. Instalar o app'
    ],
    note: 'O dispositivo precisa estar registrado ANTES de gerar o build',
    autoRegister: 'Agora você pode registrar automaticamente na página de instalação!'
  });
});

// Servir install.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'install.html'));
});

// Servir outros arquivos estáticos
app.use(express.static(__dirname, {
  setHeaders: (res, filePath) => {
    // Se for um arquivo .plist, garantir Content-Type correto
    if (filePath.endsWith('.plist')) {
      res.setHeader('Content-Type', 'application/xml');
    }
  }
}));

const PORT = process.env.PORT || 3748;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  console.log(`📱 Acesse: http://localhost:${PORT}/`);
  console.log(`📋 Manifest: http://localhost:${PORT}/manifest.plist`);
  console.log(`\n⚠️  IMPORTANTE: O manifest.plist será servido com Content-Type: application/xml`);
});

