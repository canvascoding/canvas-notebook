import { test, expect, type Page } from '@playwright/test';

const TEST_EMAIL = process.env.E2E_EMAIL || 'admin.com';
const TEST_PASSWORD = process.env.E2E_PASSWORD || 'change-me';

/**
 * Ollama Provider Integration Tests
 * 
 * These tests verify that:
 * 1. Ollama appears in the provider discovery list
 * 2. Ollama models are correctly listed
 * 3. Provider help documentation is available
 * 4. Configuration can be saved with Ollama provider
 */

test.describe('Ollama Provider Integration', () => {
  async function ensureLoggedIn(page: Page) {
    if (!page.url().includes('/login')) {
      return;
    }

    await page.getByPlaceholder('Enter email').fill(TEST_EMAIL);
    await page.getByPlaceholder('Enter password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Login' }).click();
    await page.waitForURL((url) => !url.pathname.includes('/login'));
  }

  async function openAgentSettings(page: Page) {
    await page.goto('/settings');
    await ensureLoggedIn(page);
    if (!page.url().includes('/settings')) {
      await page.goto('/settings?tab=agent-settings');
    }
    await page.waitForURL(/\/settings/);
    await page.waitForSelector('text=Agent Settings');
    const agentSettingsTab = page.locator('text=Agent Settings').first();
    await agentSettingsTab.click();
    await page.waitForSelector('[data-testid="provider-select"]');
  }

  test('Ollama provider appears in discovery list', async ({ page }) => {
    await openAgentSettings(page);

    // Check if 'ollama' is in the provider dropdown
    const providerSelect = page.getByTestId('provider-select');
    const options = await providerSelect.locator('option').allTextContents();

    expect(options).toContain('ollama');
  });

  test('Ollama models are displayed when provider is selected', async ({ page }) => {
    await openAgentSettings(page);

    // Select Ollama provider
    const providerSelect = page.getByTestId('provider-select');
    await providerSelect.selectOption('ollama');

    const modelSelect = page.getByTestId('model-select');
    const modelOptions = await modelSelect.locator('option').allTextContents();

    // Verify expected models are available
    const expectedModels = [
      'Llama 3.1',
      'Llama 3.2',
      'Mistral',
      'Qwen 2.5 Coder 32B',
      'DeepSeek R1 32B',
      'GLM-4',
      'Kimi K2.5'
    ];
    
    for (const modelName of expectedModels) {
      const hasModel = modelOptions.some(option => 
        option.toLowerCase().includes(modelName.toLowerCase())
      );
      expect(hasModel, `Expected model "${modelName}" to be available`).toBeTruthy();
    }
  });

  test('Ollama provider help section is displayed', async ({ page }) => {
    await openAgentSettings(page);

    // Select Ollama provider
    const providerSelect = page.getByTestId('provider-select');
    await providerSelect.selectOption('ollama');

    // Click on the collapsible help section
    const helpTrigger = page.locator('text=Ollama - Konfiguration').first();
    await helpTrigger.click();
    
    // Wait for help content to expand
    await page.waitForSelector('text=Local & Remote LLM');
    
    // Verify key sections are present
    await expect(page.locator('text=Einrichtung:')).toBeVisible();
    await expect(page.locator('text=API-Keys konfigurieren:')).toBeVisible();
    await expect(page.locator('text=CLI-Befehle:')).toBeVisible();
    await expect(page.locator('text=Hinweise:')).toBeVisible();
    
    // Check for specific Ollama CLI commands
    await expect(page.locator('text=ollama pull llama3.1')).toBeVisible();
    await expect(page.locator('text=ollama serve')).toBeVisible();
    await expect(page.locator('text=ollama list')).toBeVisible();
    
    // Check for cloud model references
    await expect(page.locator('text=GLM 4.6')).toBeVisible();
    await expect(page.locator('text=Kimi K2.5')).toBeVisible();
    await expect(page.locator('text=Qwen 3.5')).toBeVisible();
  });

  test('Ollama configuration can be saved', async ({ page }) => {
    await openAgentSettings(page);

    // Select Ollama provider
    const providerSelect = page.getByTestId('provider-select');
    await providerSelect.selectOption('ollama');

    // Select a model
    const modelSelect = page.getByTestId('model-select');
    await modelSelect.selectOption('llama3.1');
    
    // Set thinking level
    const thinkingSelect = page.locator('select').filter({ hasText: /none|low|medium|high/i }).first();
    if (await thinkingSelect.isVisible()) {
      await thinkingSelect.selectOption('medium');
    }
    
    // Click save button
    const saveButton = page.locator('button:has-text("Einstellungen speichern")');
    await saveButton.click();
    
    // Wait for success message
    await expect(page.locator('text=Agent-Konfiguration gespeichert.')).toBeVisible({ timeout: 5000 });
    
    // Verify the configuration was saved by reloading
    await page.reload();
    await page.waitForSelector('text=Agent Settings');
    
    // Check that Ollama is still selected
    const providerValue = await providerSelect.inputValue();
    expect(providerValue).toBe('ollama');
  });

  test('Provider help shows Ollama specific environment variables', async ({ page }) => {
    await openAgentSettings(page);

    // Select Ollama provider
    const providerSelect = page.getByTestId('provider-select');
    await providerSelect.selectOption('ollama');
    
    // Open help section
    const helpTrigger = page.locator('text=Ollama - Konfiguration').first();
    await helpTrigger.click();
    
    // Wait for environment variables section
    await page.waitForSelector('text=OLLAMA_API_KEY');
    
    // Verify environment variable descriptions
    await expect(page.locator('text=Pflichtfeld für Ollama')).toBeVisible();
    await expect(page.locator('text=automatisch erzeugten Zahlenketten-Fallback')).toBeVisible();
  });

  test('Ollama configuration accordion and custom model flow work in settings', async ({ page }) => {
    await openAgentSettings(page);

    await page.getByTestId('provider-select').selectOption('ollama');

    await expect(page.getByTestId('model-select')).toBeVisible();
    await expect(page.getByTestId('ollama-config-toggle')).toBeVisible();
    await expect(page.getByTestId('ollama-server-select')).toHaveCount(0);

    await page.getByTestId('ollama-config-toggle').click();
    await expect(page.getByTestId('ollama-server-select')).toBeVisible();

    await page.getByTestId('model-select').selectOption('custom');
    await expect(page.getByTestId('ollama-custom-model-input')).toBeVisible();

    await page.getByTestId('ollama-server-select').selectOption('cloud');
    await expect(page.getByTestId('ollama-remote-url')).toBeVisible();
  });

  test('custom Ollama model requires a value before saving', async ({ page }) => {
    await openAgentSettings(page);

    await page.getByTestId('provider-select').selectOption('ollama');
    await page.getByTestId('model-select').selectOption('custom');
    await page.getByTestId('ollama-custom-model-input').fill('');

    await page.getByRole('button', { name: 'Einstellungen speichern' }).click();

    await expect(page.locator('text=Bitte trage einen Namen für das Custom Ollama Model ein.')).toBeVisible();
  });

  test('ollama api key fallback hint is visible', async ({ page }) => {
    await openAgentSettings(page);

    await page.getByTestId('provider-select').selectOption('ollama');
    await page.locator('text=Ollama - Konfiguration').first().click();

    await expect(page.locator('text=zufällige Zahlenkette')).toBeVisible();
  });
});
