import type { Meta, StoryObj } from "@storybook/react-vite";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs.js";

const meta = {
  title: "Components/Tabs",
  component: Tabs,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Inspector: Story = {
  render: () => (
    <div className="story-panel" style={{ width: "28rem" }}>
      <Tabs defaultValue="inspector">
        <TabsList label="Right panel">
          <TabsTrigger value="inspector">Inspector</TabsTrigger>
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="inspector">
          Solo, mute, volume, pan and the vibe sliders for the selected instrument.
        </TabsContent>
        <TabsContent value="chat">The prompt bar, with suggestions for the selection.</TabsContent>
        <TabsContent value="history">Every version of this song, newest first.</TabsContent>
      </Tabs>
    </div>
  ),
};

export const WithDisabledTab: Story = {
  render: () => (
    <div className="story-panel" style={{ width: "28rem" }}>
      <Tabs defaultValue="inspector">
        <TabsList label="Right panel">
          <TabsTrigger value="inspector">Inspector</TabsTrigger>
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="history" disabled>
            History
          </TabsTrigger>
        </TabsList>
        <TabsContent value="inspector">Nothing selected yet.</TabsContent>
        <TabsContent value="chat">Ask for a change.</TabsContent>
      </Tabs>
    </div>
  ),
};

export const Vertical: Story = {
  render: () => (
    <div className="story-panel">
      <Tabs defaultValue="parts" orientation="vertical">
        <TabsList label="Song details">
          <TabsTrigger value="parts">Parts</TabsTrigger>
          <TabsTrigger value="instruments">Instruments</TabsTrigger>
          <TabsTrigger value="lyrics">Lyrics</TabsTrigger>
        </TabsList>
        <TabsContent value="parts">
          Intro, Verse 1, Chorus, Verse 2, Chorus, Bridge, Outro.
        </TabsContent>
        <TabsContent value="instruments">Vocals, Drums, Bass, Synths, Piano.</TabsContent>
        <TabsContent value="lyrics">No lyrics found in this song.</TabsContent>
      </Tabs>
    </div>
  ),
};
