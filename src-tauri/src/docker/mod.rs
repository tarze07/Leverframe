//! Docker containers with agents (docs/DOCKER.md): the `docker` CLI, not its API – it works with
//! Docker Engine and Docker Desktop, and needs no async runtime. It reads what Docker has
//! (version, images, containers, volumes, details of a container – D1, #63) and manages it:
//! new containers for agents, start / stop / remove, pull and build with progress, logs (D2, #64).

pub mod actions;
mod cli;
pub mod commands;
pub mod jobs;
mod model;

pub use actions::{ContainerSpec, CreatePlan};
pub use cli::{Docker, DockerError};
pub use jobs::{DockerJobs, JobEvent, JobEvents};
pub use model::{
    ContainerDetails, ContainerMount, DockerContainer, DockerImage, DockerInfo, DockerVolume,
    LEVERFRAME_LABEL,
};

#[cfg(test)]
mod tests;
