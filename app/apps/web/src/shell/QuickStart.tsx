/**
 * The in-app quick start (R0.10): the header's Help button and the native Help
 * menu open the same dialog. Bundled, so it works offline.
 */
import { Modal } from "../ui/Modal.tsx";

const STEPS: readonly { title: string; body: string }[] = [
  { title: "Start a project", body: "Use New project, Open folder or Open sample rocket from the File menu or the project menu in the header." },
  { title: "Build the rocket", body: "On the Design tab, press the plus button at the top of the Components list to add a part, then edit the selected part's fields. Changes save as you go." },
  { title: "Set the materials", body: "A part with no material adds no mass. On Design, open Components, then Materials to create a material or copy one from the library, and choose it on each part's Material tab." },
  { title: "Choose a motor", body: "On Design, open Configurations to pick a motor and set when the recovery devices deploy." },
  { title: "Check the model", body: "Press Check model in the header to find missing inputs and problems before you fly." },
  { title: "Fly it", body: "On the Results tab, add a simulation with New simulation, set the launch conditions, then press Run." },
  { title: "Ask the agent", body: "The pane on the right can explain results and edit the design for you. Every change it makes appears in the history strip." },
  { title: "Go back", body: "Undo and Redo step through the design history. In a text field they undo your typing." },
];

export function QuickStart({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Quick start"
      testId="quick-start"
      footer={
        <button type="button" className="rw-button rw-button--primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <ol className="rw-quick-start">
        {STEPS.map((step) => (
          <li key={step.title}>
            <strong>{step.title}.</strong> {step.body}
          </li>
        ))}
      </ol>
    </Modal>
  );
}
