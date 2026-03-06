/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import React from 'react';
import { KeyIcon } from './icons';

interface ApiKeyDialogProps {
  onContinue: () => void;
}

const ApiKeyDialog: React.FC<ApiKeyDialogProps> = ({ onContinue }) => {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 border border-gray-700 rounded-2xl shadow-xl max-w-lg w-full p-8 text-center flex flex-col items-center">
        <div className="bg-indigo-600/20 p-4 rounded-full mb-6">
          <KeyIcon className="w-12 h-12 text-indigo-400" />
        </div>
        <h2 className="text-3xl font-bold text-white mb-4">Paid API Key Required for Veo</h2>
        <p className="text-gray-300 mb-6">
          Veo is a paid-only video generation model. To use this feature, please select an API key associated with a paid Google Cloud project that has billing enabled.
        </p>
        <p className="text-gray-400 mb-8 text-sm">
          For more information, see the{' '}
          <a
            href="https://ai.google.dev/gemini-api/docs/billing"
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-400 hover:underline font-medium"
          >
            how to enable billing
          </a>{' '}
          and{' '}
          <a
            href="https://ai.google.dev/gemini-api/docs/pricing#veo-3"
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-400 hover:underline font-medium"
          >
            Veo pricing
          </a>.
        </p>
        <button
          onClick={onContinue}
          className="w-full px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg transition-colors text-lg"
        >
          Continue to Select a Paid API Key
        </button>
      </div>
    </div>
  );
};

export default ApiKeyDialog;
