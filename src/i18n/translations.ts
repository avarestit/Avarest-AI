import type { LanguageCode } from '../shared/types.ts';

export interface TranslationBundle {
  brandName: string;
  brandTagline: string;
  nav: {
    home: string;
    chat: string;
    brain: string;
    agents: string;
    research: string;
    coder: string;
    studio: string;
    knowledge: string;
    integrations: string;
    projects: string;
    billing: string;
    settings: string;
    admin: string;
  };
  topbar: {
    beginnerMode: string;
    advancedMode: string;
    signIn: string;
    signOut: string;
    newChat: string;
  };
  home: {
    welcomeTitle: string;
    welcomeSubtitle: string;
    promptPlaceholder: string;
    sendButton: string;
    quickActionsTitle: string;
    actions: {
      ask: string;
      research: string;
      code: string;
      create: string;
      analyze: string;
      agent: string;
    };
    recentConversations: string;
    recentProjects: string;
    emptyConversations: string;
    emptyProjects: string;
    onboardingTitle: string;
    onboardingDesc: string;
  };
  chat: {
    searchPlaceholder: string;
    newConversation: string;
    autoRoutingLabel: string;
    manualModelLabel: string;
    compareToggle: string;
    stopGenerating: string;
    retry: string;
    copy: string;
    copied: string;
    attachFile: string;
    useKnowledge: string;
    deleteConfirmTitle: string;
    deleteConfirmBody: string;
    cancel: string;
    confirmDelete: string;
    rename: string;
    archive: string;
    emptyStateTitle: string;
    emptyStateDesc: string;
  };
  auth: {
    signInTitle: string;
    signUpTitle: string;
    emailLabel: string;
    passwordLabel: string;
    nameLabel: string;
    submitSignIn: string;
    submitSignUp: string;
    switchToSignUp: string;
    switchToSignIn: string;
    sandboxNotice: string;
  };
}

export const TRANSLATIONS: Record<LanguageCode, TranslationBundle> = {
  en: {
    brandName: 'Avarest One',
    brandTagline: 'One Platform. Every Intelligence.',
    nav: {
      home: 'Home',
      chat: 'AI Chat & Hub',
      brain: 'Avarest Brain',
      agents: 'AI Agents & Work',
      research: 'Deep Research',
      coder: 'AI Coder',
      studio: 'Creation Studio',
      knowledge: 'Knowledge & Memory',
      integrations: 'Connected Apps',
      projects: 'Projects & History',
      billing: 'Usage & Billing',
      settings: 'Settings & Security',
      admin: 'Admin Console',
    },
    topbar: {
      beginnerMode: 'Beginner',
      advancedMode: 'Advanced',
      signIn: 'Sign In',
      signOut: 'Sign Out',
      newChat: 'New Chat',
    },
    home: {
      welcomeTitle: 'What would you like to accomplish today?',
      welcomeSubtitle:
        'Avarest Brain automatically selects the best configured intelligence for your task.',
      promptPlaceholder: 'Ask anything, draft a plan, write code, or research a topic...',
      sendButton: 'Start Task',
      quickActionsTitle: 'Quick Actions',
      actions: {
        ask: 'Ask AI',
        research: 'Research',
        code: 'Code',
        create: 'Create',
        analyze: 'Analyze',
        agent: 'Build an Agent',
      },
      recentConversations: 'Recent Conversations',
      recentProjects: 'Recent Projects',
      emptyConversations: 'No conversations yet. Start a task above to create your first session.',
      emptyProjects: 'No projects yet. Create a workspace project to organize chats and instructions.',
      onboardingTitle: 'Getting started with Avarest One',
      onboardingDesc:
        'Stay in Beginner mode for automatic model routing, or switch to Advanced mode at any time for manual model selection, agents, and Brain controls.',
    },
    chat: {
      searchPlaceholder: 'Search conversations...',
      newConversation: 'New Chat',
      autoRoutingLabel: 'Automatic (Avarest Brain)',
      manualModelLabel: 'Manual Model',
      compareToggle: 'Compare',
      stopGenerating: 'Stop',
      retry: 'Retry',
      copy: 'Copy',
      copied: 'Copied',
      attachFile: 'Attach Text/Doc',
      useKnowledge: 'Use Knowledge Base',
      deleteConfirmTitle: 'Delete conversation?',
      deleteConfirmBody: 'This permanently removes the conversation and its messages.',
      cancel: 'Cancel',
      confirmDelete: 'Delete',
      rename: 'Rename',
      archive: 'Archive',
      emptyStateTitle: 'Start a conversation',
      emptyStateDesc:
        'Avarest Brain routes your prompt to the optimal server-configured model automatically.',
    },
    auth: {
      signInTitle: 'Sign in to Avarest One',
      signUpTitle: 'Create your Avarest One account',
      emailLabel: 'Email address',
      passwordLabel: 'Password',
      nameLabel: 'Full name',
      submitSignIn: 'Sign In',
      submitSignUp: 'Create Account',
      switchToSignUp: 'Need an account? Register',
      switchToSignIn: 'Already have an account? Sign in',
      sandboxNotice:
        'Local Staging Auth Mode is active because Supabase keys are not configured in this environment.',
    },
  },
  bn: {
    brandName: 'আভারেস্ট ওয়ান',
    brandTagline: 'একটি প্ল্যাটফর্ম। প্রতিটি বুদ্ধিমত্তা।',
    nav: {
      home: 'হোম',
      chat: 'এআই চ্যাট ও হাব',
      brain: 'আভারেস্ট ব্রেইন',
      agents: 'এআই এজেন্ট ও কাজ',
      research: 'ডিপ রিসার্চ',
      coder: 'এআই কোডার',
      studio: 'ক্রিয়েশন স্টুডিও',
      knowledge: 'নলেজ ও মেমোরি',
      integrations: 'সংযুক্ত অ্যাপস',
      projects: 'প্রজেক্ট ও হিস্ট্রি',
      billing: 'ব্যবহার ও বিলিং',
      settings: 'সেটিংস ও নিরাপত্তা',
      admin: 'অ্যাডমিন কনসোল',
    },
    topbar: {
      beginnerMode: 'সহজ মোড',
      advancedMode: 'অ্যাডভান্সড',
      signIn: 'সাইন ইন',
      signOut: 'সাইন আউট',
      newChat: 'নতুন চ্যাট',
    },
    home: {
      welcomeTitle: 'আজ আপনি কী কাজ করতে চান?',
      welcomeSubtitle:
        'আভারেস্ট ব্রেইন স্বয়ংক্রিয়ভাবে আপনার কাজের জন্য সেরা এআই মডেল নির্বাচন করে।',
      promptPlaceholder: 'যেকোনো প্রশ্ন করুন, কোড লিখুন বা গবেষণা শুরু করুন...',
      sendButton: 'শুরু করুন',
      quickActionsTitle: 'দ্রুত কাজ শুরু করুন',
      actions: {
        ask: 'এআই-কে জিজ্ঞাসা করুন',
        research: 'গবেষণা',
        code: 'কোড লিখুন',
        create: 'তৈরি করুন',
        analyze: 'বিশ্লেষণ',
        agent: 'এজেন্ট তৈরি',
      },
      recentConversations: 'সাম্প্রতিক কথোপকথন',
      recentProjects: 'সাম্প্রতিক প্রজেক্ট',
      emptyConversations: 'এখনো কোনো কথোপকথন নেই। উপরে প্রশ্ন লিখে প্রথম চ্যাট শুরু করুন।',
      emptyProjects: 'এখনো কোনো প্রজেক্ট নেই। আপনার কাজ সাজাতে একটি প্রজেক্ট তৈরি করুন।',
      onboardingTitle: 'আভারেস্ট ওয়ান ব্যবহার নির্দেশিকা',
      onboardingDesc:
        'স্বয়ংক্রিয় মডেল নির্বাচনের জন্য সহজ মোড ব্যবহার করুন, অথবা ম্যানুয়াল মডেল ও এজেন্ট নিয়ন্ত্রণের জন্য অ্যাডভান্সড মোডে যান।',
    },
    chat: {
      searchPlaceholder: 'কথোপকথন খুঁজুন...',
      newConversation: 'নতুন চ্যাট',
      autoRoutingLabel: 'স্বয়ংক্রিয় (আভারেস্ট ব্রেইন)',
      manualModelLabel: 'ম্যানুয়াল মডেল',
      compareToggle: 'তুলনা করুন',
      stopGenerating: 'থামান',
      retry: 'আবার চেষ্টা',
      copy: 'কপি',
      copied: 'কপি হয়েছে',
      attachFile: 'ফাইল যুক্ত করুন',
      useKnowledge: 'নলেজ বেস ব্যবহার',
      deleteConfirmTitle: 'কথোপকথন মুছবেন?',
      deleteConfirmBody: 'এটি চ্যাট এবং এর সমস্ত বার্তা স্থায়ীভাবে মুছে ফেলবে।',
      cancel: 'বাতিল',
      confirmDelete: 'মুছে ফেলুন',
      rename: 'নাম পরিবর্তন',
      archive: 'আর্কাইভ',
      emptyStateTitle: 'কথোপকথন শুরু করুন',
      emptyStateDesc: 'আভারেস্ট ব্রেইন স্বয়ংক্রিয়ভাবে আপনার প্রশ্ন সেরা কনফিগার করা মডেলে পাঠাবে।',
    },
    auth: {
      signInTitle: 'আভারেস্ট ওয়ান-এ সাইন ইন করুন',
      signUpTitle: 'আভারেস্ট ওয়ান অ্যাকাউন্ট তৈরি করুন',
      emailLabel: 'ইমেইল ঠিকানা',
      passwordLabel: 'পাসওয়ার্ড',
      nameLabel: 'পূর্ণ নাম',
      submitSignIn: 'সাইন ইন',
      submitSignUp: 'অ্যাকাউন্ট তৈরি করুন',
      switchToSignUp: 'নতুন অ্যাকাউন্ট প্রয়োজন? নিবন্ধন করুন',
      switchToSignIn: 'ইতিমধ্যে অ্যাকাউন্ট আছে? সাইন ইন করুন',
      sandboxNotice:
        'Supabase কী কনফিগার না থাকায় লোকাল স্টেজিং অথেনটিকেশন মোড চালু আছে।',
    },
  },
};
