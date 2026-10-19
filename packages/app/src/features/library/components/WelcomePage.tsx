/**
 * `/`: the welcome page. Dropping a song starts the analysis flow; the existing
 * local project list stays below it (the WP-0.5 platform scenario still drives
 * that list, and it is a legitimate second way to start a song).
 */
import { ProjectsPage } from "../../projects/components/ProjectsPage.js";
import { LibrarySection } from "./LibrarySection.js";

export function WelcomePage() {
  return (
    <div className="welcome">
      <LibrarySection />
      <ProjectsPage />
    </div>
  );
}
