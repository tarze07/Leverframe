//! Docker containers with agents (docs/DOCKER.md): the `docker` CLI, not its API – it works with
//! Docker Engine and Docker Desktop, and needs no async runtime. This part (D1, #63) reads what
//! Docker has: version, images, containers, volumes, details of a container.

mod cli;
pub mod commands;
mod model;

pub use cli::{Docker, DockerError};
pub use model::{
    ContainerDetails, ContainerMount, DockerContainer, DockerImage, DockerInfo, DockerVolume,
    LEVERFRAME_LABEL,
};

#[cfg(test)]
mod tests;
