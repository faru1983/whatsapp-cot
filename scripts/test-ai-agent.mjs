// ==============================================================================
// OBJETIVO: Simulador CLI interactivo para probar el nuevo Agente Autónomo IA (V2).
// Permite conversar en tiempo real, ver respuestas, tools invocadas y mute.
// ==============================================================================

import readline from 'node:readline';
import process from 'node:process';
import { processAiAgentMessage } from '../src/agent-ia/index.js';
import { getSession, resetSession } from '../src/core/db.js';
import { formatPrice } from '../src/logic/utils.js';

const SESSION_ID = 'test-cli-agent-ia@s.whatsapp.net';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('\n================================================================');
console.log('🤖 SIMULADOR INTERACTIVO — AGENTE AUTÓNOMO IA (COCKTAILS ON TAP)');
console.log('================================================================');
console.log('Escribe tus mensajes como si fueras un cliente en WhatsApp.');
console.log('Comandos de prueba:');
console.log('  /reset   - Reiniciar conversación');
console.log('  /status  - Ver estado de sesión y Mute');
console.log('  /exit    - Salir del simulador\n');

function askQuestion() {
  rl.question('\n👤 Cliente > ', async (input) => {
    const text = input.trim();
    if (!text) {
      askQuestion();
      return;
    }

    if (text === '/exit' || text === 'exit') {
      console.log('\n👋 Saliendo del simulador...');
      rl.close();
      process.exit(0);
    }

    if (text === '/status') {
      const s = getSession(SESSION_ID);
      console.log('\n📊 ESTADO DE SESIÓN:');
      console.log(`- Muted: ${s.isMuted ? '🔴 SÍ (Silenciado / Requiere humano)' : '🟢 NO (Activo)'}`);
      console.log(`- Turnos en memoria: ${s.history?.turns?.length || 0}`);
      console.log(`- Teléfono: ${s.clientPhoneE164 || 'No asignado'}`);
      console.log(`- CRM Sincronizado: ${s.crmCuriousSynced ? 'Curioso ✅' : 'No'} | ${s.crmEngagedSynced ? 'Interesado ✅' : 'No'}`);
      askQuestion();
      return;
    }

    try {
      const mockAlertAdmin = async (alert) => {
        console.log(`\n🔔 [ALERTA INTERNA AL ADMIN]:\n   Tipo: ${alert.type} | Título: ${alert.title}\n   ${alert.body.replace(/\n/g, '\n   ')}`);
      };

      const mockApplyBusinessLabel = async (label) => {
        console.log(`\n🏷️ [ETIQUETA BUSINESS APLICADA]: "${label}"`);
      };

      console.log('⏳ Procesando respuesta del Agente IA...');
      const reply = await processAiAgentMessage(SESSION_ID, text, {
        sendAdminAlert: mockAlertAdmin,
        applyBusinessLabel: mockApplyBusinessLabel,
        clientPhoneE164: '+56912345678',
        pushName: 'Cliente Prueba'
      });

      if (reply) {
        if (Array.isArray(reply)) {
          console.log(`\n🍸 Agente IA (${reply.length} burbujas) >`);
          reply.forEach((b, idx) => {
            const content = typeof b === 'object' ? `[Media: ${b.file}]` : b;
            console.log(`\n💬 [Burbuja ${idx + 1}]:\n${content}`);
          });
        } else {
          console.log(`\n🍸 Agente IA >\n${reply}`);
        }
      } else {
        console.log('\n🤫 [El agente está en MUTE y no respondió al cliente]');
      }

    } catch (err) {
      console.error('\n❌ Error procesando mensaje:', err);
    }

    askQuestion();
  });
}

askQuestion();
