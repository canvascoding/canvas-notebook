import { test, expect } from '@playwright/test';

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
  test('Ollama provider appears in discovery list', async ({ page }) => {
    // Navigate to settings page
    await page.goto('/settings');
    
    // Wait for the Agent Settings tab to be visible
    await page.waitForSelector('text=Agent Settings');
    
    // Click on Agent Settings tab if not already active
    const agentSettingsTab = page.locator('text=Agent Settings').first();
    await agentSettingsTab.click();
    
    // Wait for provider dropdown to load
    await page.waitForSelector('select');
    
    // Check if 'ollama' is in the provider dropdown
    const providerSelect = page.locator('select').first();
    const options = await providerSelect.locator('option').allTextContents();
    
    expect(options).toContain('ollama');
  });

  test('Ollama models are displayed when provider is selected', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForSelector('text=Agent Settings');
    
    // Select Ollama provider
    const providerSelect = page.locator('select').first();
    await providerSelect.selectOption('ollama');
    
    // Wait for model dropdown to update
    await page.waitForTimeout(500);
    
    // Find model dropdown (second select element)
    const modelSelect = page.locator('select').nth(1);
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
    await page.goto('/settings');
    await page.waitForSelector('text=Agent Settings');
    
    // Select Ollama provider
    const providerSelect = page.locator('select').first();
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
    await expect(page.locator('text=GLM 5.6')).toBeVisible();
    await expect(page.locator('text=Kimi K2.5')).toBeVisible();
    await expect(page.locator('text=Qwen 3.5')).toBeVisible();
  });

  test('Ollama configuration can be saved', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForSelector('text=Agent Settings');
    
    // Select Ollama provider
    const providerSelect = page.locator('select').first();
    await providerSelect.selectOption('ollama');
    
    // Wait for model dropdown to appear
    await page.waitForTimeout(500);
    
    // Select a model
    const modelSelect = page.locator('select').nth(1);
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
    await page.goto('/settings');
    await page.waitForSelector('text=Agent Settings');
    
    // Select Ollama provider
    const providerSelect = page.locator('select').first();
    await providerSelect.selectOption('ollama');
    
    // Open help section
    const helpTrigger = page.locator('text=Ollama - Konfiguration').first();
    await helpTrigger.click();
    
    // Wait for environment variables section
    await page.waitForSelector('text=OLLAMA_HOST');
    
    // Verify environment variable descriptions
    await expect(page.locator('text=Ollama server URL')).toBeVisible();
    await expect(page.locator('text=Optional API key for Ollama Cloud')).toBeVisible();
  });
});
